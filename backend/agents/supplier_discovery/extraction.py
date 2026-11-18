import json
import re
from bs4 import BeautifulSoup

CITIES = ['Karachi', 'Lahore', 'Islamabad', 'Faisalabad', 'Sialkot', 'Gujranwala', 'Multan', 'Rawalpindi', 'Hyderabad', 'Peshawar']
PRODUCTS = ['corrugated', 'carton', 'cardboard', 'paperboard', 'packaging', 'paper bags', 'folding', 'flexible packaging', 'boxes']


def extract(html, url):
    soup = BeautifulSoup(html, 'html.parser')
    organization = {}
    for script in soup.select('script[type="application/ld+json"]'):
        try:
            value = json.loads(script.string or '')
            entries = value if isinstance(value, list) else value.get('@graph', [value])
            for entry in entries:
                types = entry.get('@type', [])
                if isinstance(types, str):
                    types = [types]
                if set(types) & {'Organization', 'LocalBusiness', 'Corporation', 'Manufacturer'}:
                    organization = entry
                    break
        except (ValueError, AttributeError, TypeError):
            continue
    for tag in soup(['script', 'style', 'noscript']):
        tag.decompose()
    text = soup.get_text(' ', strip=True)
    meta = soup.select_one('meta[property="og:site_name"]')
    heading = soup.find('title') or soup.find('h1')
    company = organization.get('name') or (meta.get('content') if meta else None) or (heading.get_text(' ', strip=True) if heading else '')
    company = re.split(r'\s[|–—]\s', str(company))[0].strip()[:200]
    address = organization.get('address') or {}
    if not isinstance(address, dict):
        address = {}
    city = address.get('addressLocality') or next((c for c in CITIES if c.lower() in text.lower()), '')
    products = [p for p in PRODUCTS if p in text.lower()]
    emails = re.findall(r'[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}', text)
    mailto = [(href or '')[7:].split('?')[0] for a in soup.select('a[href^="mailto:"]') for href in [a.get('href')]]
    phones = [a.get('href', '')[4:] for a in soup.select('a[href^="tel:"]')]
    email = str(organization.get('email') or next(iter(mailto + emails), ''))[:200]
    phone = str(organization.get('telephone') or next(iter(phones), ''))[:120]
    data = {'company': company, 'website': url, 'city': str(city)[:200], 'country': 'Pakistan' if 'pakistan' in text.lower() else '',
            'products': products, 'email': email, 'phone': phone}
    snippets = []
    for term in [company, city, email, phone, 'Pakistan'] + products:
        if not term:
            continue
        index = text.lower().find(str(term).lower())
        if index >= 0:
            snippets.append({'field_value': term, 'quote': text[max(0, index-80):index+len(term)+160]})
    return data, {'extractor': 'deterministic-html-v1', 'fields': data.copy(), 'snippets': snippets, 'text_excerpt': text[:12000],
                  'manufacturer_claim': bool(re.search(r'manufactur|\bfactory\b|\bproducer\b', text, re.I))}


def validate(data, filters):
    if data['company'].lower() in ('home', 'welcome', 'about us', 'contact us', 'products'):
        return 'Cannot establish company identity from source evidence'
    if not data['company'] or len(data['company']) < 3 or not data['products'] or data['country'] != 'Pakistan':
        return 'Insufficient evidence of a named Pakistani packaging business'
    haystack = ' '.join([data['company'], data['city']] + data['products']).lower()
    if filters.get('city') and filters['city'].lower() not in haystack:
        return 'Does not match city filter'
    # Categories can be represented by separate extracted terms ("corrugated",
    # "carton", "packaging", "boxes"). Do not require them to be adjacent.
    product_terms = re.findall(r'\w+', filters.get('product', '').lower())
    if product_terms and not all(term in haystack for term in product_terms):
        return 'Does not match product filter'
    return ''
