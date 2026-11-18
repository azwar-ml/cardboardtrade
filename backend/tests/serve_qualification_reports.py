"""Read-only HTTP review of persisted real reports. Background scheduling stays unstarted."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from main import app
from fastapi.responses import JSONResponse


@app.middleware('http')
async def review_only(request, call_next):
    comparison = request.method == 'POST' and request.url.path == '/api/v1/qualification/market/compare'
    if request.method != 'GET' and not comparison:
        return JSONResponse({'detail': 'This report review server accepts GET requests only'}, status_code=405)
    return await call_next(request)


if __name__ == '__main__':
    import uvicorn
    uvicorn.run(app, host='127.0.0.1', port=8013, lifespan='off', access_log=False)
