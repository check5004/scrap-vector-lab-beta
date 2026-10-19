# AI steel texture assets

`ai-steel-textures.json` is a versioned, self-contained base64 bundle of three
1254 × 1254 JPEG material images. Their full prompts, generation source,
original hashes, encoded hashes, and byte counts are recorded in
`ai-steel-provenance.json`. There are no service URLs, credentials, reference
photographs, or private inputs in this bundle.

The surfaces were generated with OpenAI's built-in image generation tool on
2026-10-15. They were exported to progressive JPEG at quality 60 without content
or color edits. Image-model generation itself is not deterministic; the saved
bytes are the reproducible source assets.

`python scripts/generate_samples.py` verifies the source SHA-256 hashes and
maps the three materials into exact L-shaped, notched, and round-hole trapezoid
geometry. It then renders the calibration paper, real `DICT_4X4_50` markers,
contact shadow, table background, and perspective. The resulting files are
`public/samples/ai-*.jpg`; masks and geometry are stored separately. All three
delivered JPEGs are decoded and checked by OpenCV for marker IDs 0, 1, 2, and 3.

Describe these examples as **AI-generated steel textures + controlled
geometric composites**. They are neither camera captures nor untouched
AI-generated photographs, and they do not demonstrate real-world measurement
accuracy. The image model never generates the markers or measurement truth.

The original three procedural fixtures are retained unchanged, allowing
appearance-only comparisons on the same shapes and perspective transforms.
