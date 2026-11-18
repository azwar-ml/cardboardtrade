from typing import Optional, Literal, List, Dict
from decimal import Decimal
from pydantic import BaseModel, ConfigDict, Field


class Strict(BaseModel):
    model_config = ConfigDict(extra='forbid', str_strip_whitespace=True, validate_default=True)


class Settings(Strict):
    paused: bool = False
    monitor_interval_seconds: int = Field(60, ge=30, le=86400)
    fresh_days: int = Field(14, ge=1, le=365)
    warning_days: int = Field(3, ge=0, le=30)
    expire_days: int = Field(30, ge=1, le=730)
    category_days: Dict[str,int] = Field(default_factory=dict, max_length=30)
    contact_days: int = Field(7, ge=1, le=365)
    response_days: int = Field(3, ge=1, le=30)
    first_followup_days: int = Field(3, ge=1, le=90)
    second_followup_days: int = Field(7, ge=2, le=180)
    max_followups: int = Field(2, ge=0, le=2)
    skip_weekends: bool = True
    daily_limit: int = Field(10, ge=1, le=100)
    automatic_drafts: bool = False
    ai_enabled: bool = False
    quantity_change_pct: Decimal = Field(20, ge=0, le=1000)
    price_change_pct: Decimal = Field(5, ge=0, le=1000)
    attachment_mb: int = Field(10, ge=1, le=20)
    retention_days: int = Field(365, ge=30, le=3650)


RequestType = Literal['Initial availability','Updated inventory','Price confirmation','MOQ confirmation',
 'Lead-time confirmation','Specification clarification','Availability reconfirmation','Unanswered follow-up',
 'Incomplete response','Received information','Updated catalog','Quoted availability']


class Enquiry(Strict):
    vendor_id: int
    contact_id: int
    watch_ids: List[int] = Field(min_length=1,max_length=30)
    request_type: RequestType = 'Initial availability'


class Incoming(Strict):
    source_id: str = Field(min_length=1,max_length=200)
    sender: str = Field(max_length=320)
    recipient: str = Field('stock@cardboardpackage.com',max_length=320)
    subject: str = Field('',max_length=300)
    body: str = Field('',max_length=50000)
    html: Optional[str] = Field(None,max_length=100000)
    in_reply_to: Optional[str] = Field(None,max_length=300)
    references: Optional[str] = Field(None,max_length=2000)
    thread_token: Optional[str] = Field(None,max_length=100)
    authenticated: bool = False
    process_now: bool = False
    source_at: Optional[str] = None


class Extracted(Strict):
    product_ref: str = Field(min_length=1,max_length=200)
    name: Optional[str] = Field(None,max_length=500)
    board: Optional[str] = Field(None,max_length=1000)
    grade: Optional[str] = Field(None,max_length=200)
    gsm: Optional[Decimal] = Field(None,gt=0,le=10000)
    length_mm: Optional[Decimal] = Field(None,gt=0,le=100000)
    width_mm: Optional[Decimal] = Field(None,gt=0,le=100000)
    height_mm: Optional[Decimal] = Field(None,gt=0,le=100000)
    form: Optional[Literal['sheets','reels','boxes','bags','other']] = None
    quantity: Optional[Decimal] = Field(None,ge=0,le=1000000000)
    quantity_unit: Optional[Literal['piece','kg','ton','sheet','reel']] = None
    price: Optional[Decimal] = Field(None,ge=0,le=1000000000)
    currency: Optional[Literal['PKR','USD']] = None
    price_unit: Optional[str] = Field(None,max_length=100)
    moq: Optional[int] = Field(None,ge=1,le=1000000000)
    lead_days: Optional[int] = Field(None,ge=0,le=3650)
    available_from: Optional[str] = None
    valid_until: Optional[str] = None
    terms: Optional[str] = Field(None,max_length=2000)
    notes: Optional[str] = Field(None,max_length=3000)
    availability: Literal['Confirmed','Estimated','Future production','Unavailable','Historical','Conditional','Unknown'] = 'Unknown'


class WireClaim(Strict):
    product_ref: str
    field: str
    value: str
    quote: str
    source: int = Field(ge=0)


class WireClaims(Strict):
    claims: List[WireClaim] = Field(max_length=100)
