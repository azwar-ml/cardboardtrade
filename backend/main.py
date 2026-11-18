import asyncio
import contextlib
from contextlib import asynccontextmanager
from pathlib import Path
from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

# Also support the existing `uvicorn main:app --app-dir backend` run command.
load_dotenv(Path(__file__).with_name('.env'))

from agents.mock_catalog import MOCK_AGENTS
from agents.supplier_discovery.api import router
from agents.supplier_discovery.storage import migrate, connection, now, database_fingerprint
from agents.supplier_discovery.workflow import scheduler
from agents.supplier_qualification.api import router as qualification_router
from agents.supplier_qualification.storage import migrate as migrate_qualification
from agents.supplier_qualification.workflow import worker as qualification_worker
from agents.supplier_catalog_intake.api import router as catalog_router
from agents.supplier_catalog_intake.storage import migrate as migrate_catalog
from agents.supplier_catalog_intake.workflow import worker as catalog_worker, recover as recover_catalog
from agents.supplier_catalog_intake.limits import CatalogBodyLimit
from agents.supplier_stock_monitor.api import router as stock_router, webhooks as stock_webhooks, StockBodyLimit
from agents.supplier_stock_monitor.storage import migrate as migrate_stock
from agents.supplier_stock_monitor.workflow import worker as stock_worker, recover as recover_stock

@asynccontextmanager
async def lifespan(app):
    migrate()
    migrate_qualification()
    migrate_catalog()
    migrate_stock()
    recover_stock()
    stock_task = asyncio.create_task(stock_worker())
    recover_catalog()
    catalog_task = asyncio.create_task(catalog_worker())
    with connection() as conn:
        conn.execute("UPDATE discovery_jobs SET status='Failed',stage='Interrupted',error='Service restarted',finished_at=? WHERE status IN ('Queued','Running')", (now(),))
    task = asyncio.create_task(scheduler())
    with connection() as conn:
        conn.execute("UPDATE qualification_jobs SET status='Failed',error='Service restarted',finished_at=? WHERE status='Running'", (now(),))
    qualification_task = asyncio.create_task(qualification_worker())
    yield
    task.cancel()
    qualification_task.cancel()
    catalog_task.cancel()
    stock_task.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await task
    with contextlib.suppress(asyncio.CancelledError):
        await qualification_task
    with contextlib.suppress(asyncio.CancelledError):
        await catalog_task
    with contextlib.suppress(asyncio.CancelledError):
        await stock_task


app = FastAPI(title="Cardboard Package API", version="1.4.0", lifespan=lifespan)
app.include_router(router)
app.include_router(qualification_router)
app.include_router(catalog_router)
app.include_router(stock_router)
app.include_router(stock_webhooks)
app.add_middleware(StockBodyLimit)
app.add_middleware(CatalogBodyLimit)


@app.middleware('http')
async def identify_database(request, call_next):
    response = await call_next(request)
    response.headers['X-Trade-Database'] = database_fingerprint()
    return response
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_methods=["GET"],
    allow_headers=["*"],
)


@app.get("/health")
def health():
    import os
    return {"status": "ok", "service": "cardboard-package", "version": app.version,
            "process_id": os.getpid(), "database_fingerprint": database_fingerprint(),
            "capabilities": ["supplier-stock", "supplier-catalog", "supplier-qualification", "market-comparison", "gemini-analysis", "supplier-discovery", "automatic-supplier-search", "discovery-scheduler", "duckduckgo-serpapi", "discovery-cancellation", "rotating-48h-automation", "provider-billing-cycle-budget"], "mode": "four implemented agents; email remains local/mock"}


@app.get("/api/v1/agents")
def agents():
    return {"mode": "mixed", "agents": [
        {**agent, "status": "implemented-development", "mode": "development", "metrics": {},
         "activity": ["Implemented Admin workflow; production activation is separate",
                      "Real email delivery is disabled in normal local development" if agent['id'] == 'supplier-stock' else "Catalog publication requires Admin approval"]}
        if agent['id'] in ('supplier-catalog', 'supplier-stock') else
        {**agent, "mode": "live", "metrics": {}, "activity": ["Admin authentication required for live discovery records"]}
        if agent['id'] in ('supplier-discovery', 'supplier-qualification') else {**agent, "mode": "demo"} for agent in MOCK_AGENTS
    ]}
