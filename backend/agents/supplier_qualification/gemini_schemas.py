"""Small Gemini transport schemas, adapted to the existing validated domain models."""
from typing import Literal, get_args

from pydantic import ConfigDict, Field, field_validator
from .models import StrictModel, Claim, Extraction, PriceReference, Specification

CATEGORIES = get_args(Claim.model_fields['category'].annotation)
CATEGORY_ALIASES = {'company name': 'identity', 'country': 'address', 'city': 'address'}


def normalize_category(value):
    if not isinstance(value, str):
        return value
    label = ' '.join(value.strip().casefold().replace('_', ' ').split())
    # Unknown labels pass through to the existing Literal validator for rejection.
    return CATEGORY_ALIASES.get(label, label)


class SupplierFact(Claim):
    kind: Literal['claim', 'contradiction', 'credibility', 'report', 'product_match']

    @field_validator('category', mode='before')
    @classmethod
    def canonical_category(cls, value):
        return normalize_category(value)


class SupplierOutput(StrictModel):
    facts: list[SupplierFact] = Field(max_length=4)


class MarketItem(StrictModel):
    model_config = ConfigDict(extra='forbid', strict=True, str_max_length=2000)
    evidence_id: str
    quote: str
    description: str
    packaging_type: str
    dimensions_mm: str
    material: str
    flute: str
    ply: str
    printing: str
    finishing: str
    price_text: str
    amount: str
    currency: str
    pieces_per_unit: str
    moq: str
    channel: str


class MarketOutput(StrictModel):
    items: list[MarketItem] = Field(max_length=4)


def schema(workload):
    root, fields = ('items', MarketItem.model_fields) if workload == 'market' else ('facts', SupplierFact.model_fields)
    properties = {name: {'type': 'string'} for name in fields}
    if workload != 'market':
        properties['category']['enum'] = list(CATEGORIES)
    # Provider output needs only one array of flat string records. Rich constraints
    # remain in Pydantic rather than the server's schema-constrained decoder.
    return {'type': 'object', 'properties': {root: {'type': 'array', 'items': {
        'type': 'object', 'properties': properties,
        'required': list(fields), 'additionalProperties': False}}},
        'required': [root], 'additionalProperties': False}


def instructions(workload):
    if workload == 'market':
        return ('Return items with flat product fields. Copy every populated field verbatim from its quote. '
                'Use empty strings for unknown fields. price_text preserves the published price or range. '
                'amount must be empty for a price range. currency must be empty unless an ISO code is explicitly present. '
                'Do not infer unit quantity, MOQ, channel, material, flute or dimensions. Never convert units. ')
    return ('Return facts with kind claim, contradiction, credibility, report or product_match. '
            'category must be exactly one of: ' + ', '.join(CATEGORIES) + '. '
            'Use identity for company or legal name. Use address for city, country or postal address. '
            'Use the canonical category tokens exactly, including lowercase spelling. '
            'Copy each value verbatim from its quote. ')


def parse(text, workload, evidence):
    output = Extraction()
    if workload != 'market':
        wire = SupplierOutput.model_validate_json(text)
        fields = {'claim': 'claims', 'contradiction': 'contradictions', 'credibility': 'credibility_evidence',
                  'report': 'report_points', 'product_match': 'product_matches'}
        for fact in wire.facts:
            claim = Claim.model_validate(fact.model_dump(exclude={'kind'}))
            getattr(output, fields[fact.kind]).append(claim)
        return output
    wire = MarketOutput.model_validate_json(text)
    sources = {source.id: source for source in evidence}
    for item in wire.items:
        source = sources.get(item.evidence_id)
        if source is None or item.quote not in source.text:
            raise ValueError('Market extraction lacks an exact retrieved source quotation')
        for field, value in item.model_dump().items():
            if field not in ('evidence_id', 'quote') and value and value.casefold() not in item.quote.casefold():
                raise ValueError('Extracted market field lacks literal quoted evidence: ' + field)
        if item.description:
            output.product_matches.append(Claim(category='products', value=item.description, evidence_id=item.evidence_id, quote=item.quote))
        if item.price_text:
            output.market_summary.append(Claim(category='products', value=item.price_text, evidence_id=item.evidence_id, quote=item.quote))
        # Incomplete observations remain source-linked annotations. They cannot
        # become a price reference through guessed currency, units or market channel.
        if not all((item.description, item.amount, item.currency, item.pieces_per_unit, item.channel)):
            continue
        spec = Specification(**{field: getattr(item, field) for field in Specification.model_fields})
        price = PriceReference(description=item.description, specification=spec, amount=item.amount,
            currency=item.currency, pieces_per_unit=int(item.pieces_per_unit), moq=int(item.moq) if item.moq else None,
            channel=item.channel, price_kind='advertised', source_url=source.url,
            observed_at=source.observed_at, source_quote=item.quote, evidence_id=source.id)
        output.prices.append(price)
    return output
