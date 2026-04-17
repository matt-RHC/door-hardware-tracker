#!/usr/bin/env python3
"""
Standalone HTTP server that wraps the Vercel Python serverless functions
for local development. Serves extract-tables.py on port 3001.

The Next.js parse-pdf route calls these via fetch, so we need them running
locally when Vercel CLI doesn't serve Python functions.

Usage: python3 scripts/serve-python-api.py
"""
import sys
import os
from http.server import HTTPServer
from pathlib import Path

# Add project root to path so we can import from api/
PROJECT_ROOT = Path(__file__).resolve().parent.parent
API_DIR = PROJECT_ROOT / "api"
sys.path.insert(0, str(API_DIR))

# Import the handler from extract-tables.py using importlib
import importlib.util

def import_module(filename):
    module_name = filename.replace("-", "_").replace(".py", "")
    spec = importlib.util.spec_from_file_location(module_name, API_DIR / filename)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = mod
    spec.loader.exec_module(mod)
    return mod

# Import and rebuild Pydantic models (needed for Python 3.9 + from __future__ import annotations)
extract_tables_mod = import_module("extract-tables.py")
for attr_name in dir(extract_tables_mod):
    attr = getattr(extract_tables_mod, attr_name)
    if isinstance(attr, type) and hasattr(attr, 'model_rebuild'):
        try:
            attr.model_rebuild()
        except Exception:
            pass

ExtractTablesHandler = extract_tables_mod.handler

PORT = 3001

if __name__ == "__main__":
    server = HTTPServer(("localhost", PORT), ExtractTablesHandler)
    print(f"Python API server running on http://localhost:{PORT}")
    print("Serving: /api/extract-tables (POST)")
    print("Press Ctrl+C to stop")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
        server.server_close()
