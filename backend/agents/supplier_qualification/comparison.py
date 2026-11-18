from decimal import Decimal, localcontext
from .models import CompareRequest, PriceReference


def normalized(value):
    return ' '.join(value.lower().split())


def compare(request: CompareRequest, references: list):
    with localcontext() as context:
        context.prec = 60
        return compare_references(request, references)


def compare_references(request, references):
    matched, excluded = [], []
    seen = set()
    for record in sorted(references, key=lambda item: item['reference']['observed_at'], reverse=True):
        reference = PriceReference.model_validate(record['reference'])
        identity = (str(reference.source_url).rstrip('/'), reference.specification.model_dump_json(), reference.currency,
                    reference.channel, reference.price_kind, reference.pieces_per_unit, reference.tier_min, reference.tier_max)
        if identity in seen:
            continue
        seen.add(identity)
        reasons = []
        for field, expected in request.specification.model_dump().items():
            actual = getattr(reference.specification, field)
            if not expected or not actual:
                reasons.append('Missing specification ' + field)
            elif normalized(expected) != normalized(actual):
                reasons.append('Different specification ' + field)
        if request.channel != reference.channel:
            reasons.append('Different retail/wholesale channel')
        if request.price_kind != reference.price_kind:
            reasons.append('Different price evidence type')
        if reference.moq is None:
            reasons.append('MOQ unknown')
        elif request.quantity < reference.moq:
            reasons.append('Quantity below MOQ')
        if request.quantity < reference.tier_min or (reference.tier_max and request.quantity > reference.tier_max):
            reasons.append('Quantity outside price tier')
        rate = Decimal(1)
        fx = None
        if reference.currency != request.currency:
            fx = next((r for r in request.exchange_rates if r.currency == reference.currency and r.target_currency == request.currency), None)
            if fx is None:
                reasons.append('Missing sourced exchange rate')
            else:
                rate = fx.rate
        item = {'id': record['id'], 'reference': reference.model_dump(mode='json')}
        if reasons:
            excluded.append({**item, 'reasons': reasons})
            continue
        base = reference.amount / reference.pieces_per_unit * rate
        missing = [field for field in ('shipping', 'tax', 'other_cost') if getattr(reference, field) is None]
        # Ancillary costs are totals for the requested order, in the reference currency.
        known_cost = sum((getattr(reference, field) or Decimal(0) for field in ('shipping', 'tax', 'other_cost')), Decimal(0))
        matched.append({**item, 'price_per_piece': str(base),
                        'known_total_per_piece': str(base + known_cost * rate / request.quantity),
                        'missing_cost_components': missing, 'currency': request.currency,
                        'exchange_rate': fx.model_dump(mode='json') if fx else None})
    prices = sorted(Decimal(r['price_per_piece']) for r in matched)
    median = (prices[(len(prices)-1)//2] + prices[len(prices)//2]) / 2 if prices else None
    for item in matched:
        price = Decimal(item['price_per_piece'])
        item['unusual_price'] = bool(len(prices) >= 3 and (price < median / 2 or price > median * 2))
    return {'status': 'Comparable Data Available' if len(prices) >= 2 else 'Insufficient Comparable Data',
            'matched': matched, 'excluded': excluded, 'currency': request.currency,
            'range': {'low': str(min(prices)), 'high': str(max(prices))} if len(prices) >= 2 else None,
            'cost_basis': 'Listed price per piece. Known ancillary costs shown separately. Ancillary inputs are order totals.'}
