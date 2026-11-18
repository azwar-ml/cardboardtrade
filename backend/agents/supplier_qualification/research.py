"""Reuse the shared SerpApi ledger and Crawlee guarded page retrieval."""
import datetime as dt
import uuid
import json
from bs4 import BeautifulSoup
from crawlee import ConcurrencySettings
from crawlee.crawlers import BasicCrawler
from crawlee.storages import RequestQueue
from agents.supplier_discovery.providers import duckduckgo_search, configuration
from agents.supplier_discovery.safety import permitted_page
from agents.supplier_discovery.extraction import extract
from agents.supplier_discovery.storage import now, domain
from .models import Evidence
from .gemini import safe_error


async def research(criteria, website='', source_urls=None, search_enabled=False):
    evidence, errors, results = [], [], []
    if search_enabled:
        try:
            _, results = await duckduckgo_search(criteria)
        except Exception as exc:
            errors.append(safe_error(exc))
    urls = list(source_urls or [])
    for index, item in enumerate(results[:4]):
        evidence.append(Evidence(id='search-' + str(index), url=item['url'], observed_at=now(),
                                 kind='search', text=(item['title'] + '\n' + item['snippet'])[:16000]))
        urls.append(item['url'])
    urls = list(dict.fromkeys(urls))[:3]
    if not urls:
        return evidence, errors
    config = configuration()
    allowed = None if config['source_policy'] == 'public' else set(config['allowed_domains'])
    robots = {}
    queue = await RequestQueue.open(name='qualification-' + uuid.uuid4().hex)
    crawler = BasicCrawler(request_manager=queue, max_request_retries=0, use_session_pool=False,
                           retry_on_blocked=False, request_handler_timeout=dt.timedelta(seconds=90),
                           concurrency_settings=ConcurrencySettings(min_concurrency=1, max_concurrency=1, desired_concurrency=1))

    @crawler.router.default_handler
    async def handle(context):
        url = context.request.url
        try:
            html, final = await permitted_page(url, allowed, robots)
            data, extracted = extract(html, final)
            excerpt = company_context(extracted['text_excerpt'], criteria.get('company', ''))
            if excerpt:
                data['verification_excerpt'] = excerpt
            data['price_references'] = structured_prices(html, final, extracted['text_excerpt'], now(), 'page-' + str(len(evidence)))
            official_hosts = {'secp.gov.pk', 'fbr.gov.pk', 'iafcertsearch.org'}
            kind = 'supplier' if website and domain(final) == domain(website) else 'official' if domain(final) in official_hosts else 'independent'
            observed = data['price_references'][0]['observed_at'] if data['price_references'] else now()
            evidence.append(Evidence(id='page-' + str(len(evidence)), url=final, kind=kind, observed_at=observed,
                                     fields=data, text=extracted['text_excerpt']))
        except Exception as exc:
            errors.append(safe_error(url + ' — ' + str(exc)))

    @crawler.failed_request_handler
    async def failed(context, error):
        errors.append(safe_error(context.request.url + ' — ' + str(error)))

    try:
        await crawler.run(urls)
    finally:
        await queue.drop()
    return evidence, errors


def company_context(text, company):
    """Use the company entry from a directory without its navigation/category lists."""
    import re
    if not company:
        return ''
    match = re.search(re.escape(company) + r'\s+is listed\b.*?(?=\s+Share:|$)', text, re.I | re.S)
    return match[0] if match else ''


def structured_prices(html, url, text, observed_at, evidence_id):
    """Extract explicit Product/Offer fields only when price units and market channel are stated."""
    import re
    from .models import PriceReference, Specification
    soup = BeautifulSoup(html, 'html.parser')
    prices = []
    for script in soup.select('script[type="application/ld+json"]'):
        try:
            raw = json.loads(script.string or '')
            entries = raw if isinstance(raw, list) else raw.get('@graph', [raw])
            for product in entries:
                if product.get('@type') != 'Product':
                    continue
                properties = {str(p.get('name', '')).lower(): str(p.get('value', '')) for p in product.get('additionalProperty', []) if isinstance(p, dict)}
                channel = properties.get('channel', '').lower()
                if channel not in ('wholesale', 'retail'):
                    continue
                offers = product.get('offers', [])
                if isinstance(offers, dict):
                    offers = [offers]
                for offer in offers:
                    unit = offer.get('priceSpecification', {}).get('referenceQuantity', {})
                    if unit.get('unitCode') != 'C62' or not unit.get('value'):
                        continue
                    amount, currency = str(offer.get('price', '')), str(offer.get('priceCurrency', ''))
                    # A visible quotation must contain both the literal amount and currency.
                    match = re.search(re.escape(currency) + r'\s*' + re.escape(amount) + r'\b|' + re.escape(amount) + r'\s*' + re.escape(currency), text)
                    if not match:
                        continue
                    quote = text[max(0, match.start()-100):match.end()+150]
                    spec = Specification(**{field: properties.get(field, '') for field in Specification.model_fields})
                    eligible = offer.get('eligibleQuantity', {})
                    value = PriceReference(description=str(product.get('name', '')), specification=spec, amount=amount,
                        currency=currency, pieces_per_unit=int(unit['value']), price_unit=str(unit['value']) + ' pieces',
                        moq=int(eligible['minValue']) if eligible.get('minValue') else None,
                        tier_min=int(eligible.get('minValue') or 1), tier_max=int(eligible['maxValue']) if eligible.get('maxValue') else None,
                        channel=channel, price_kind='advertised', source_url=url, source_quote=quote,
                        observed_at=observed_at, evidence_id=evidence_id)
                    prices.append(value.model_dump(mode='json'))
        except (ValueError, TypeError, AttributeError, KeyError):
            continue
    return prices


def extract_prices(evidence):
    """Conservative rule-based parsing of explicit JSON-LD Product/Offer evidence.

    Complete specification fields remain required by the comparator. Arbitrary prose prices
    and model-suggested prices require Admin-confirmed source-backed entry.
    """
    from .models import PriceReference
    records = []
    for source in evidence:
        for item in source.fields.get('price_references', []):
            price = PriceReference.model_validate(item)
            if price.source_quote in source.text and str(price.source_url).rstrip('/') == source.url.rstrip('/'):
                records.append(price)
    return records


def price_observations(evidence):
    """Retain published ranges without assigning an unknown variant or price unit."""
    import re
    observations = []
    for source in evidence:
        if source.kind in ('search', 'official', 'submission'):
            continue
        match = re.search(r'(?:₨|PKR|Rs\.?|US\$|\$)\s*\d[\d,]*(?:\.\d+)?(?:\s*[–-]\s*(?:₨|PKR|Rs\.?|US\$|\$)?\s*\d[\d,]*(?:\.\d+)?)?', source.text)
        if not match:
            continue
        observations.append({'evidence_id': source.id, 'source_url': source.url,
            'observed_at': source.observed_at, 'published_price': match[0],
            'quote': source.text[max(0, match.start()-100):match.end()+450],
            'comparability': 'Excluded until the exact variant, price unit, material, flute, printing, quantity tier and delivery costs are established'})
    return observations


def validate_price_quote(price):
    import re
    from decimal import Decimal
    numbers = [Decimal(token.replace(',', '')) for token in re.findall(r'(?<![\w.])\d[\d,]*(?:\.\d+)?(?![\w.])', price.source_quote)]
    if price.amount not in numbers or price.currency.casefold() not in price.source_quote.casefold():
        raise ValueError('Price amount and currency must appear in the exact source quotation')
    if price.pieces_per_unit != 1 and Decimal(price.pieces_per_unit) not in numbers:
        raise ValueError('Unit quantity must appear in the exact source quotation')
    normalized_quote = re.sub(r'[^a-z0-9]', '', price.source_quote.casefold())
    for field, value in price.specification.model_dump().items():
        if not value:
            continue
        normalized_value = re.sub(r'[^a-z0-9]', '', value.casefold())
        explicit_absence = value.casefold() == 'none' and ('no' + field) in normalized_quote
        if normalized_value not in normalized_quote and not explicit_absence:
            raise ValueError('Specification ' + field + ' requires an explicit source quotation')
    for field in ('shipping', 'tax', 'other_cost'):
        cost = getattr(price, field)
        if cost is not None and cost not in numbers:
            raise ValueError('Known cost component must appear in the exact source quotation')
