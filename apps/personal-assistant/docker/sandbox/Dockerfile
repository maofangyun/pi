FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONUTF8=1 \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir \
    pandas \
    openpyxl \
    pymupdf \
    duckdb \
    sympy \
    matplotlib \
    ruff

RUN useradd --create-home --uid 1000 --shell /bin/sh sandbox \
    && mkdir -p /workspace /evidence /knowledge \
    && chown -R sandbox:sandbox /workspace

USER sandbox
WORKDIR /workspace

CMD ["sh"]
