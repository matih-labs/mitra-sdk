# Regenerating models

The models in `src/mitra/models.py` are hand-written for the main shapes and accept unknown
fields. To get models for every schema in the spec, generate them from the synced OpenAPI file:

```bash
pip install datamodel-code-generator
datamodel-codegen \
  --input ../../openapi/openapi.json --input-file-type openapi \
  --output-model-type pydantic_v2.BaseModel \
  --output /tmp/mitra_generated_models.py
```

Use the output to compare against `models.py` when the spec changes; copy over new fields by hand
so the public surface stays small and stable.
