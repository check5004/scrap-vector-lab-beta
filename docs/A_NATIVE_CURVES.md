# Mode A: image-derived mixed line/cubic estimates (dev.5 beta)

Mode A sends the same rectified, millimetre-grid image to the selected provider. It now asks for straight edges and sustained curved intervals directly from that image, with straight measurement edges preferred over noise/texture/weld-mark micro-curves. This is not smoothing the former sparse polygon. Top-face targeting, occlusion, sidewall and uncertainty flags remain mandatory.

This native curve response has been verified with explicit local provider-response stubs only. **No paid model call or physical accuracy validation was performed.** Schema acceptance and geometric validity are not evidence that the model followed the photographed boundary. Unlike B, A has no dense reference contour and no contour-fit error bound. Compare with the photograph and measure before machining.

## Representation and rejection rules

Each ring contains at least three non-repeated anchors with `x`, `y`, `incoming`, `outgoing`. Control coordinates are absolute millimetres. For the directed edge i→i+1, outgoing(i) and incoming(i+1) must both be null (straight) or both finite points (cubic). The closing edge uses this same rule. No implicit closing duplicate or partial one-control cubic is accepted. All anchors and controls must lie inside the board, a conservative beta limitation that may reject otherwise valid curves with external control hulls.

Strict point objects forbid additional fields. The parser enforces the entire response as either native vertices or old two-coordinate vertices; mixed representations are rejected. Existing legacy polygon responses remain accepted and are labelled `legacy-polygon`. A new response with all null handles is `native-bezier` with legitimately straight geometry, not failed curve detection. The accepted geometry after straight-first simplification retains its remaining cubic controls losslessly, while a 0.01 mm flattened polygon supports the existing geometric fallback and calibration interface; it is not an independent raw contour.

Invalid numbers, excessive vertices, inconsistent paired handles, crossings detected by 0.01 mm flattening, invalid holes, or flattening complexity are rejected. This approximate topology check cannot certify the absence of sub-0.01 mm intersections. Existing refusal, non-completed Responses status and non-stop Chat Completions finish-reason handling reject truncated output rather than presenting partial success. The 5000-token cap is unchanged. This limits cost, but complicated outlines can fail and require a simpler view; no hidden retry/provider/mode switch is performed.

## Primary protocol references

- OpenAI Structured Outputs: https://developers.openai.com/api/docs/guides/structured-outputs . Required nullable fields, nested `anyOf`, and `additionalProperties:false` are used.
- OpenRouter Structured Outputs: https://openrouter.ai/docs/guides/features/structured-outputs . Strict `json_schema` requests and `require_parameters:true` are retained; endpoint enforcement can vary, so local validation is required.

These documents support the transport/schema design, not real-model geometric accuracy or successful live acceptance of this particular new schema.

## Straight-first postprocessing

The shared detailed settings pass line tolerance and minimum curved support to the image prompt (UI defaults 1 mm / 5 mm). A cubic whose two controls are within the line tolerance of its finite chord can be replaced by that chord: the convex-hull property bounds the displacement from the supplied AI cubic. All proposed replacements are accepted atomically only if resulting hole/topology validation passes. Counts/settings are exported as `curve_simplification`; this bound is against the AI curve, not the photograph. Minimum support in A is a model instruction, not a verified image feature-size guarantee. True broad arcs remain cubic and within-tolerance subtle detail can become a measurement line, so compare the photograph.
