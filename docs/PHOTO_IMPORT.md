# Photo library and camera import

Use **写真を選ぶ** to select an existing image. This input deliberately has **no `capture` attribute**, so the application does not request camera-only capture. Use **カメラで撮影** for the separate camera input, which requests `capture="environment"`. The browser/device still controls the native chooser, available menu choices, camera permissions, and preferred camera.

Both routes run the same local image validation, decoding, marker recognition and calibration. Both are disabled while a pipeline is running or paused. Cancel or finish that pipeline to select another image. Selecting the same file again reruns processing; cancelling a native picker without choosing a file leaves the previous source unchanged.

## Formats and orientation

- Maximum input file size: 30 MB. Decoded images are also subject to the existing 60 MP limit and processing-size reduction.
- JPEG and PNG are the most portable choices. The app also attempts any other image format that the current browser can decode.
- HEIC/HEIF is not rejected just because of its extension. If decoding fails, the message explains that the browser may not support the file or that it may be damaged, and suggests a JPEG/PNG copy. No conversion service or additional upload is used.
- The browser's native image decoder handles JPEG EXIF orientation. The app does not apply a second manual rotation. Automated tests cover the final dimensions and pixels for all eight orientation tags.
- As before, Mode B processing stays on the device. Images are sent externally only after the explicit Analyze action with A selected or B’s optional visual review enabled; provider, purpose, paid use, and call limit are disclosed beside that action.

## Verification boundary

The automated import tests exercise desktop Chromium and Pixel 7 Chromium emulation, including distinct chooser wiring, both upload routes, busy locks, same-file retry, oversize rejection, corrupt-file/HEIC error messages, Blob URL cleanup, and actual JPEG EXIF metadata. Native photo-library/camera presentation and successful HEIC decoding on a physical iPhone are separate device checks; they are not established by Chromium emulation.

On an iPhone, verify that the library button offers an existing photo, the camera button offers capture, cancelling either picker preserves the current image, and portrait/landscape photos appear in the correct orientation. If a HEIC cannot be opened, retry a JPEG/PNG copy and check important dimensions against a physical measurement.

## Primary references

- [W3C HTML Media Capture](https://www.w3.org/TR/html-media-capture/) specifies the capture preference; the user agent controls implementation and picker behavior.
- [WebKit's Safari 17.0 feature notes](https://webkit.org/blog/14445/webkit-features-in-safari-17-0/) document HEIC support. This supports attempting native decoding rather than making a blanket unsupported-format claim.
- [WebKit's Safari 17.2 feature notes](https://webkit.org/blog/14787/webkit-features-in-safari-17-2/) discuss image orientation and EXIF metadata. The test suite checks the retained decoder-to-canvas path rather than adding a potentially duplicated rotation.
