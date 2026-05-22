# Size Guide Graphic — Vision Critique Rubric

You are judging a 2000×2000 Etsy listing photo for a nursery wall-art print. The graphic must look like it belongs in the same family as a premium "What's Included" deliverables card: calm, warm-neutral, lots of intentional whitespace, cream background (#EDE8E1), sage green accents (#6B7F5E), Inter typography, HillwardStudio header/footer.

## PASS criteria (all must be true)

1. **Composition fills the canvas** — the diagram is the focal point and uses the central area well. No large empty void above or beside the main content. Header/title/footer are present but the size comparison dominates visually.

2. **Frames are large and legible** — the five print sizes (8×10, 11×14, 16×20, 18×24, 24×36) are outlined rectangles, drawn to scale, stepped along ONE shared baseline ascending smallest→largest left to right. They must NOT be tiny elements crammed in a corner. Each dimension label must be readable at thumbnail size (~200px wide).

3. **Scale honesty** — frame proportions must reflect real inch ratios (portrait orientation: 8×10 through 24×36). The standing adult silhouette must be ~66 inches tall on the same baseline so the 24×36 frame reads as roughly half an adult's height. The 24×36 frame top should align near the person's mid-chest (~36″ from feet), not shoulders or neck.

4. **Person silhouette** — must use a solid filled wayfinding-style figure (restroom/airport sign aesthetic): one smooth unified shape with head, torso, and separated legs. NOT a stick figure, NOT line-art limbs, NOT a circle-head with single-line arms/legs, NOT clip-art, NOT a wireframe placeholder. Must match the same fill+stroke treatment as the frame rectangles.

5. **Aesthetic cohesion** — every visual element must match the same level of refinement. REJECT anything that looks like clip-art, a wireframe, a stick figure, a placeholder, or a child's drawing in an otherwise polished design. The graphic must look like it came from a professional boutique print shop.

6. **Visual consistency** — line-art and filled elements must follow ONE consistent visual language. Do not mix flat-filled frames with an outline-only figure, or mismatched stroke weights/treatments between frames and the person.

7. **No clutter** — no dotted callout lines, no annotation arrows, no "wireframe legend" text, no scale rulers unless they are minimal and elegant.

8. **Brand consistency** — HILLWARDSTUDIO eyebrow, "Size Guide" title treatment, thin divider rules, caption, and "VINTAGE BUNNY NURSERY PRINT" footer must remain styled consistently with a premium nursery brand.

9. **Professional finish** — looks like a real Etsy listing graphic a buyer would trust, not a developer diagram or placeholder.

## Quality score

In your META JSON, include `"quality_score": <1-10>` where 10 = flawless boutique-ready and 1 = unusable placeholder. Use this honestly — regressions (missing person, stick figure, tiny frames) should score ≤4.

## When to REVISE

If any PASS criterion fails, return REVISE with specific, actionable fixes tied to what you see in the rendered PNG. Rewrite the complete HTML to address those issues while preserving the header/footer brand styling. Prefer referencing `templates/assets/silhouettes/adult.svg` for the person rather than drawing a figure from scratch.

## When to PASS

Only PASS when you would confidently upload this image as slot 4 on an Etsy listing without further manual design work.
