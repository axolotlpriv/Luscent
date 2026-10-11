# Third-party notices

Luscent bundles the following third-party material.

## gl-transitions

Shader transitions are converted at runtime from the `gl-transitions` package (https://github.com/gl-transitions/gl-transitions). Each transition keeps its author and license, which you can see in **Plugins → Library**. 123 of the 125 are MIT-licensed.

```
MIT License

Copyright (c) 2017-present gl-transitions contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

The other two use BSD licenses, as stated in their headers: `InvertedPageCurl` is BSD 3-Clause and `StereoViewer` is BSD 2-Clause.

## Easing curves

The cubic-bezier approximations of the standard easing functions follow the widely used values published at easings.net.

## py_aep (After Effects file format research and test fixtures)

The After Effects RIFX parser in `src/core/ffx` follows the reverse-engineered format notes in py_aep (https://github.com/forticheprod/py_aep). The sample projects in `src/core/ffx/__fixtures__/` (`keyframe_bezier_ease_scale.aep`, `keyframe_HOLD.aep`, `2_gaussian_20_30.aep`, `expression.aep`, `effects.aep`) are copied unchanged from that repository's `samples/models/property/` folder. They are used only by the unit tests and are not part of the app bundle.

```
MIT License

Copyright (c) 2023 Fortiche production

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## ONNX Runtime Web (optional, loaded at runtime)

The optional RIFE frame interpolator loads ONNX Runtime Web (MIT, Microsoft) from the jsDelivr CDN only when the user selects it. It is not bundled. The RIFE model itself is supplied by the user.
