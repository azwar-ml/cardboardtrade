import re
from rapidfuzz.fuzz import ratio
from agents.supplier_discovery.storage import now, domain, key

CATEGORIES = ('identity', 'address', 'contact', 'products', 'manufacturing', 'registration', 'certification', 'export')
OFFICIAL = {'registration': ['https://www.secp.gov.pk/', 'https://www.fbr.gov.pk/'],
            'certification': ['https://www.iafcertsearch.org/']}


def verify(lead, evidence):
    findings = []
    values = {'identity': [lead['company']], 'address': [lead.get('city', '')],
              'contact': [lead.get('email', ''), lead.get('phone', '')],
              'products': lead.get('products', [])}
    patterns = {'manufacturing': r'manufactur\w*|\bfactory\b|\bproducer\b',
                'export': r'\bexport\w*', 'registration': r'\b(?:SECP|FBR|NTN|registered)\b',
                'certification': r'\b(?:ISO|certified|certification)\b'}
    for category in CATEGORIES:
        matches, conflicts = [], []
        for source in evidence:
            excerpt = source.fields.get('verification_excerpt', '')
            text = (excerpt if excerpt and excerpt in source.text else source.text).lower()
            # Identity association requires a matching extracted company name, or an exact company mention.
            extracted_name = str(source.fields.get('company') or '')
            associated = key(lead['company']) in key(text)
            supplier_host = source.kind == 'supplier'
            if category == 'identity' and extracted_name and supplier_host and ratio(key(extracted_name), key(lead['company'])) < 65:
                conflicts.append(source)
            if not associated:
                continue
            if category in values:
                expected = [str(v) for v in values[category] if v]
                supported = bool(expected) and all(v.lower() in text for v in expected)
            else:
                supported = bool(re.search(patterns[category], text, re.I))
            if supported:
                matches.append(source)
            if category == 'address' and source.fields.get('city') and (not excerpt or source.fields['city'].lower() in text) and lead.get('city') and source.fields['city'].lower() != lead['city'].lower():
                conflicts.append(source)
        # Registry homepages and search snippets cannot establish legal status.
        independently_supported = [s for s in matches if s.kind == 'independent' and category in values]
        result = 'Conflicting' if conflicts else 'Supported' if independently_supported else 'Partially Supported' if matches else 'Unverified'
        sources = conflicts or matches
        findings.append({'category': category, 'claim': ', '.join(values.get(category, [])) or category.title() + ' capability',
                         'result': result, 'source_urls': list(dict.fromkeys(s.url for s in sources if s.url)),
                         'evidence_ids': [s.id for s in sources], 'checked_at': now(),
                         'explanation': ('Conflicting company details require Admin review' if conflicts else
                                         'Independent public reference supports the supplied fields' if independently_supported else
                                         'Retrieved evidence records a claim requiring corroboration' if matches else 'No supporting evidence in the retrieved records'),
                         'next_action': 'Review company-specific official registry or issuing-body records and supporting documents' if category in OFFICIAL else 'Obtain independent, current supporting documents',
                         'manual_reference_urls': OFFICIAL.get(category, [])})
    score = round(sum({'Supported': 1, 'Partially Supported': .5}.get(f['result'], 0) for f in findings) / len(CATEGORIES) * 100)
    risks = [f['category'] + ' ' + f['result'].lower() for f in findings if f['result'] != 'Supported']
    return {'findings': findings, 'evidence_coverage': score, 'risk_flags': risks,
            'summary': f"{lead['company']} has {sum(f['result'] == 'Supported' for f in findings)} independently supported categories across {len(CATEGORIES)} checks.",
            'recommendation': 'Admin review and missing-document collection required',
            'score_explanation': 'Evidence coverage describes available evidence. Legal registration and certification require company-specific manual verification.'}
