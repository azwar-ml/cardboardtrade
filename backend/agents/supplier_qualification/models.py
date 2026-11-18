from decimal import Decimal
from typing import Literal, Optional
from pydantic import BaseModel, ConfigDict, Field, HttpUrl, field_validator, model_validator


class StrictModel(BaseModel):
    model_config = ConfigDict(extra='forbid')


class Evidence(StrictModel):
    id: str
    url: str
    observed_at: str
    text: str = Field(max_length=16000)
    kind: Literal['supplier', 'independent', 'search', 'submission', 'official']
    fields: dict = Field(default_factory=dict)


class Claim(StrictModel):
    category: Literal['identity', 'address', 'contact', 'products', 'manufacturing', 'registration', 'certification', 'export']
    value: str = Field(min_length=1, max_length=1000)
    evidence_id: str
    quote: str = Field(min_length=3, max_length=2000)


class Analysis(StrictModel):
    claims: list[Claim] = Field(default_factory=list, max_length=40)
    contradictions: list[Claim] = Field(default_factory=list, max_length=20)
    product_matches: list[Claim] = Field(default_factory=list, max_length=20)
    credibility_evidence: list[Claim] = Field(default_factory=list, max_length=20)
    report_points: list[Claim] = Field(default_factory=list, max_length=20)
    market_summary: list[Claim] = Field(default_factory=list, max_length=20)


class Specification(StrictModel):
    packaging_type: str = Field('', max_length=100)
    dimensions_mm: str = Field('', max_length=100)
    material: str = Field('', max_length=100)
    flute: str = Field('', max_length=40)
    ply: str = Field('', max_length=40)
    printing: str = Field('', max_length=100)
    finishing: str = Field('', max_length=100)


class PriceReference(StrictModel):
    description: str = Field(min_length=3, max_length=1000)
    specification: Specification
    amount: Decimal = Field(gt=0, max_digits=18, decimal_places=6)
    currency: str = Field(pattern='^[A-Z]{3}$')
    pieces_per_unit: int = Field(1, ge=1, le=100000000)
    price_unit: str = Field('piece', max_length=100)
    moq: Optional[int] = Field(None, ge=1)
    tier_min: int = Field(1, ge=1)
    tier_max: Optional[int] = Field(None, ge=1)
    channel: Literal['wholesale', 'retail']
    price_kind: Literal['advertised', 'estimated', 'confirmed quotation']
    shipping: Optional[Decimal] = Field(None, ge=0, max_digits=18, decimal_places=6)
    tax: Optional[Decimal] = Field(None, ge=0, max_digits=18, decimal_places=6)
    other_cost: Optional[Decimal] = Field(None, ge=0, max_digits=18, decimal_places=6)
    delivery_terms: str = Field('', max_length=500)
    source_url: HttpUrl
    observed_at: str
    source_quote: str = Field(min_length=3, max_length=4000)
    evidence_id: str

    @model_validator(mode='after')
    def valid_unit_and_tier(self):
        if self.tier_max is not None and self.tier_max < self.tier_min:
            raise ValueError('Quantity tier maximum must be at least the minimum')
        if self.price_unit == 'piece' and self.pieces_per_unit != 1:
            self.price_unit = str(self.pieces_per_unit) + ' pieces'
        return self

    @field_validator('observed_at')
    @classmethod
    def valid_date(cls, value):
        import datetime as dt
        stamp = dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
        if stamp.tzinfo is None or stamp > dt.datetime.now(dt.timezone.utc) + dt.timedelta(minutes=5):
            raise ValueError('Observation must be a past timezone-aware date')
        return value

    @field_validator('source_url')
    @classmethod
    def public_reference_url(cls, value):
        if value.username or value.password:
            raise ValueError('Source URL must not contain credentials')
        return value


class Extraction(Analysis):
    prices: list[PriceReference] = Field(default_factory=list, max_length=20)


class ExchangeRate(StrictModel):
    currency: str = Field(pattern='^[A-Z]{3}$')
    target_currency: str = Field(pattern='^[A-Z]{3}$')
    rate: Decimal = Field(gt=0, max_digits=18, decimal_places=8)
    source_url: HttpUrl
    observed_at: str

    _valid_date = field_validator('observed_at')(PriceReference.valid_date.__func__)
    _public_reference_url = field_validator('source_url')(PriceReference.public_reference_url.__func__)


class CompareRequest(StrictModel):
    specification: Specification
    quantity: int = Field(ge=1, le=100000000)
    currency: str = Field('PKR', pattern='^[A-Z]{3}$')
    channel: Literal['wholesale', 'retail'] = 'wholesale'
    price_kind: Literal['advertised', 'estimated', 'confirmed quotation'] = 'advertised'
    exchange_rates: list[ExchangeRate] = Field(default_factory=list, max_length=20)
