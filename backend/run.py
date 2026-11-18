"""Start the existing backend on the canonical port, independent of shell cwd."""
from pathlib import Path
from dotenv import load_dotenv
import uvicorn

load_dotenv(Path(__file__).with_name('.env'))  # Explicit process variables take precedence.

if __name__ == '__main__':
    from main import app
    uvicorn.run(app, host='127.0.0.1', port=8000)
