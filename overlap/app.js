import Delaunator from "https://cdn.jsdelivr.net/npm/delaunator@5/+esm";

        const MAX_IMAGES = 7;
        const DEFAULT_OPACITY = 0.1;
        const DEFAULT_RANDOM_OPACITY_MAX = 0.3;
        const MODE_OVERLAY = "overlay";
        const MODE_MORPH = "morph";
        const RANDOM_OFF = "off";
        const RANDOM_OPACITY = "opacity";
        const RANDOM_MORPH = "morph";
        const DEFAULT_HIERARCHY_SHUFFLE_INTERVAL = 5000;
        const HIERARCHY_CROSSFADE_DURATION = 10000;
        const AUTO_RANDOM_FPS = 60;
        const DEFAULT_OUTPUT_FPS = 60;
        const MORPH_WIDTH = 600;
        const MORPH_HEIGHT = 800;
        const MORPH_RATIO = MORPH_WIDTH / MORPH_HEIGHT;
        const TRIANGLE_OVERDRAW_PX = 0.75;
        const MEDIAPIPE_TASKS_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest";
        const FACE_MODEL_URL = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task";
        const MEDIAPIPE_WASM_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm";
        const REMOVE_ICON_SRC = "icon-clause.png";
        const DISPLAY_PARAMS = new URLSearchParams(window.location.search);
        const DISPLAY_SOURCE_ID = DISPLAY_PARAMS.get("sourceId");
        const DISPLAY_CANVAS_ID = DISPLAY_PARAMS.get("canvasId")?.trim() || null;
        const IS_EMBEDDED = DISPLAY_PARAMS.get("embedded") === "1";
        const requestedOutputFps = Number(DISPLAY_PARAMS.get("outputFps"));
        const OUTPUT_FPS = Number.isFinite(requestedOutputFps)
            ? Math.min(60, Math.max(1, requestedOutputFps))
            : DEFAULT_OUTPUT_FPS;
        const OUTPUT_FRAME_INTERVAL = 1000 / OUTPUT_FPS;
        const CROP_POPUP_WINDOW_NAME = DISPLAY_SOURCE_ID
            ? `canvas-popup-${DISPLAY_SOURCE_ID}`
            : "canvas-popup";
        const ALIGN_LANDMARKS = [
            33, 133, 362, 263, 1, 4, 61, 291, 199, 152
        ];
        const fileInput = document.getElementById("fileInput");
        const clearButton = document.getElementById("clearButton");
        const status = document.getElementById("status");
        const stage = document.getElementById("stage");
        const stageImageArea = document.getElementById("stageImageArea");
        const morphCanvas = document.getElementById("morphCanvas");
        const embeddedOutputCanvas = document.getElementById("embeddedOutputCanvas");
        const cropSelection = document.getElementById("cropSelection");
        const cropToggleButton = document.getElementById("cropToggleButton");
        const cropControls = document.getElementById("cropControls");
        const cropXInput = document.getElementById("cropXInput");
        const cropYInput = document.getElementById("cropYInput");
        const cropWidthInput = document.getElementById("cropWidthInput");
        const cropHeightInput = document.getElementById("cropHeightInput");
        const cropShowButton = document.getElementById("cropShowButton");
        const monoToggleButton = document.getElementById("monoToggleButton");
        const averageBlendToggleButton = document.getElementById("averageBlendToggleButton");
        const alignToggleButton = document.getElementById("alignToggleButton");
        const hierarchyToggleButton = document.getElementById("hierarchyToggleButton");
        const hierarchyIntervalControl = document.getElementById("hierarchyIntervalControl");
        const hierarchyIntervalInput = document.getElementById("hierarchyIntervalInput");
        const layerList = document.getElementById("layerList");
        const layersContainer = document.getElementById("layers");
        const addLayerSlot = document.querySelector(".addLayerSlot");
        const overlayModeButton = document.getElementById("overlayModeButton");
        const morphModeButton = document.getElementById("morphModeButton");
        const randomOpacityTotalControl = document.getElementById("randomOpacityTotalControl");
        const randomOpacityTotalInput = document.getElementById("randomOpacityTotalInput");

        let layers = [];
        let layerOpacitySettings = [];
        let draggedId = null;
        let faceLandmarkerPromise = null;
        let alignmentEnabled = true;
        let alignmentReferenceId = null;
        let monochromeEnabled = true;
        let averageBlendEnabled = false;
        let mode = MODE_OVERLAY;
        let runtimeActive = true;
        let autoRandomFrameId = null;
        let lastAutoRandomTime = 0;
        let hierarchyShuffleEnabled = false;
        let hierarchyShuffleInterval = DEFAULT_HIERARCHY_SHUFFLE_INTERVAL;
        let nextHierarchyShuffleTime = 0;
        let activeHierarchyTransition = null;
        let randomOpacityTotal = null;
        let cropEnabled = false;
        let cropDrag = null;
        let activeCropRect = null;
        let activeCropRatio = null;
        let cropPopup = null;
        let cropPopupCanvas = null;
        let cropPopupFrameId = null;
        let cropPopupCanvasId = DISPLAY_CANVAS_ID || "canvas";
        const outputFpsStats = {
            sampleStartedAt: performance.now(),
            frameCount: 0,
            measuredFps: 0,
            lastFrameAt: 0
        };
        let devicePixelRatioQuery = null;
        let devicePixelRatioListener = null;

        const createId = () => {
            if (crypto.randomUUID) return crypto.randomUUID();
            return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
        };

        function resetOutputFpsStats() {
            outputFpsStats.sampleStartedAt = performance.now();
            outputFpsStats.frameCount = 0;
            outputFpsStats.measuredFps = 0;
            outputFpsStats.lastFrameAt = 0;
        }

        function recordOutputFrame(timestamp) {
            outputFpsStats.frameCount += 1;
            outputFpsStats.lastFrameAt = timestamp;
            const sampleDuration = timestamp - outputFpsStats.sampleStartedAt;
            if (sampleDuration < 1000) return;

            outputFpsStats.measuredFps = outputFpsStats.frameCount * 1000 / sampleDuration;
            outputFpsStats.frameCount = 0;
            outputFpsStats.sampleStartedAt = timestamp;
        }

        function loadImage(src) {
            return new Promise((resolve, reject) => {
                const image = new Image();
                image.onload = () => resolve(image);
                image.onerror = reject;
                image.src = src;
            });
        }

        function loadVideo(src) {
            return new Promise((resolve, reject) => {
                const video = document.createElement("video");
                video.muted = true;
                video.loop = true;
                video.autoplay = true;
                video.playsInline = true;
                video.preload = "auto";
                video.onloadeddata = () => resolve(video);
                video.onerror = reject;
                video.src = src;
                video.load();
            });
        }

        function readFileAsDataUrl(file) {
            return new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result);
                reader.onerror = reject;
                reader.readAsDataURL(file);
            });
        }

        async function getFaceLandmarker() {
            if (!faceLandmarkerPromise) {
                faceLandmarkerPromise = import(MEDIAPIPE_TASKS_URL)
                    .then(({ FaceLandmarker, FilesetResolver }) => FilesetResolver
                        .forVisionTasks(MEDIAPIPE_WASM_URL)
                        .then((vision) => FaceLandmarker.createFromOptions(vision, {
                            baseOptions: {
                                modelAssetPath: FACE_MODEL_URL
                            },
                            runningMode: "IMAGE",
                            numFaces: 1
                        })))
                    .catch((error) => {
                        faceLandmarkerPromise = null;
                        throw error;
                    });
            }

            return faceLandmarkerPromise;
        }

        function getMediaSize(media) {
            return {
                width: media.videoWidth || media.naturalWidth || media.width || 1,
                height: media.videoHeight || media.naturalHeight || media.height || 1
            };
        }

        function createVideoFrameCanvas(video) {
            const { width, height } = getMediaSize(video);
            const canvas = document.createElement("canvas");
            const ctx = prepareCanvas(canvas, width, height);
            ctx.drawImage(video, 0, 0, width, height);
            return canvas;
        }

        async function makeFaceData(media, includeMorph = true) {
            try {
                const faceLandmarker = await getFaceLandmarker();
                const source = includeMorph ? media : createVideoFrameCanvas(media);
                const { width, height } = getMediaSize(source);

                return {
                    landmarks: detectFaceLandmarksFromSource(faceLandmarker, source, width, height),
                    morph: includeMorph ? makeMorphData(faceLandmarker, media) : null
                };
            } catch (error) {
                console.warn("Face data preparation failed.", error);
                return {
                    landmarks: null,
                    morph: null
                };
            }
        }

        function detectFaceLandmarksFromSource(faceLandmarker, source, width, height) {
            const result = faceLandmarker.detect(source);
            const landmarks = result.faceLandmarks?.[0];
            if (!landmarks) return null;

            return landmarks.map((point) => ({
                x: point.x * width,
                y: point.y * height
            }));
        }

        function getCenteredCropRect(srcWidth, srcHeight, targetRatio) {
            const srcRatio = srcWidth / srcHeight;

            if (srcRatio > targetRatio) {
                const cropHeight = srcHeight;
                const cropWidth = cropHeight * targetRatio;
                return {
                    sx: (srcWidth - cropWidth) / 2,
                    sy: 0,
                    sw: cropWidth,
                    sh: cropHeight
                };
            }

            const cropWidth = srcWidth;
            const cropHeight = cropWidth / targetRatio;
            return {
                sx: 0,
                sy: (srcHeight - cropHeight) / 2,
                sw: cropWidth,
                sh: cropHeight
            };
        }

        function createMorphSourceCanvas(image) {
            const canvas = document.createElement("canvas");
            const ctx = prepareCanvas(canvas, MORPH_WIDTH, MORPH_HEIGHT);

            const { sx, sy, sw, sh } = getCenteredCropRect(image.naturalWidth, image.naturalHeight, MORPH_RATIO);
            ctx.drawImage(image, sx, sy, sw, sh, 0, 0, MORPH_WIDTH, MORPH_HEIGHT);
            return canvas;
        }

        function makeMorphData(faceLandmarker, image) {
            const canvas = createMorphSourceCanvas(image);
            const landmarks = detectFaceLandmarksFromSource(faceLandmarker, canvas, MORPH_WIDTH, MORPH_HEIGHT);
            if (!landmarks) return null;

            const points = landmarks.map((point) => [point.x, point.y]);
            points.push([0, 0]);
            points.push([MORPH_WIDTH - 1, 0]);
            points.push([MORPH_WIDTH - 1, MORPH_HEIGHT - 1]);
            points.push([0, MORPH_HEIGHT - 1]);

            return {
                canvas,
                points
            };
        }

        async function makeLayer(file) {
            const isVideo = file.type.startsWith("video/");
            const objectUrl = isVideo ? URL.createObjectURL(file) : null;
            const src = objectUrl || await readFileAsDataUrl(file);
            let media;

            try {
                media = isVideo ? await loadVideo(src) : await loadImage(src);
            } catch (error) {
                if (objectUrl) URL.revokeObjectURL(objectUrl);
                throw error;
            }

            const size = getMediaSize(media);
            const { landmarks, morph } = await makeFaceData(media, !isVideo);
            if (isVideo) media.play().catch(() => {});

            return {
                id: createId(),
                name: file.name,
                src,
                image: media,
                mediaType: isVideo ? "video" : "image",
                objectUrl,
                stageElement: null,
                width: size.width,
                height: size.height,
                landmarks,
                morph,
                morphWeight: 100,
                opacity: DEFAULT_OPACITY,
                autoRandom: true,
                autoRandomType: RANDOM_OPACITY,
                randomOpacityMin: getDefaultRandomOpacityMin(0),
                randomOpacityMax: DEFAULT_RANDOM_OPACITY_MAX,
                randomTargets: {
                    opacity: DEFAULT_OPACITY,
                    morphWeight: 100
                }
            };
        }

        function getDefaultRandomOpacityMin(index) {
            if (index < 3) return 0.05;
            if (index === 3) return 0.07;
            return 0.1;
        }

        function getLayerOpacitySetting(index) {
            if (!layerOpacitySettings[index]) {
                layerOpacitySettings[index] = {
                    opacity: DEFAULT_OPACITY,
                    min: getDefaultRandomOpacityMin(index),
                    max: DEFAULT_RANDOM_OPACITY_MAX,
                    targetOpacity: DEFAULT_OPACITY
                };
            }
            return layerOpacitySettings[index];
        }

        function syncLayerOpacitySettings() {
            layers.forEach((layer, index) => {
                const setting = getLayerOpacitySetting(index);
                setting.opacity = layer.opacity;
                setting.targetOpacity = layer.randomTargets?.opacity ?? layer.opacity;
            });
            layerOpacitySettings.length = layers.length;
        }

        function applyLayerOpacitySettings() {
            layers = layers.map((layer, index) => {
                const setting = getLayerOpacitySetting(index);
                const opacity = clamp(setting.opacity, 0, 1);
                const targetOpacity = clamp(
                    setting.targetOpacity ?? opacity,
                    setting.min,
                    setting.max
                );
                setting.opacity = opacity;
                setting.targetOpacity = targetOpacity;
                return {
                    ...layer,
                    opacity,
                    randomOpacityMin: setting.min,
                    randomOpacityMax: setting.max,
                    randomTargets: {
                        ...layer.randomTargets,
                        opacity: targetOpacity
                    }
                };
            });
            layerOpacitySettings.length = layers.length;
        }

        async function addFiles(fileList) {
            const mediaFiles = Array.from(fileList).filter((file) => (
                file.type.startsWith("image/") || file.type.startsWith("video/")
            ));
            const slots = MAX_IMAGES - layers.length;

            if (mediaFiles.length > slots) {
                alert(`画像・動画は合計${MAX_IMAGES}点まで追加できます。`);
            }

            const selectedFiles = mediaFiles.slice(0, slots);

            if (selectedFiles.length === 0) {
                render();
                return;
            }

            const nextLayers = await Promise.all(selectedFiles.map(makeLayer));
            if (!alignmentReferenceId) {
                alignmentReferenceId = nextLayers.find((layer) => layer.landmarks)?.id || null;
            }
            layers = [...nextLayers, ...layers];
            applyLayerOpacitySettings();
            render();
        }

        function setOpacity(id, value) {
            const layerIndex = layers.findIndex((layer) => layer.id === id);
            if (layerIndex === -1) return;
            getLayerOpacitySetting(layerIndex).opacity = Number(value) / 100;
            layers = layers.map((layer) => {
                if (layer.id !== id) return layer;
                return { ...layer, opacity: Number(value) / 100 };
            });
            syncLayerOpacitySettings();
            applyRandomOpacityTotal();
            renderStage();
            renderLayerOutputs();
        }

        function setMorphWeight(id, value) {
            layers = layers.map((layer) => {
                if (layer.id !== id) return layer;
                return { ...layer, morphWeight: Number(value) };
            });
            renderStage();
            renderLayerOutputs();
        }

        function getRandomOpacityLayers() {
            if (mode !== MODE_OVERLAY) return [];
            return layers.filter((layer) => layer.autoRandom);
        }

        function getRandomOpacityTotalRange(randomLayers = getRandomOpacityLayers()) {
            return randomLayers.reduce((range, layer) => ({
                min: range.min + layer.randomOpacityMin,
                max: range.max + layer.randomOpacityMax
            }), { min: 0, max: 0 });
        }

        function distributeOpacityTotal(randomLayers, total, randomize = false) {
            const range = getRandomOpacityTotalRange(randomLayers);
            const normalizedTotal = clamp(total, range.min, range.max);
            const values = new Map(randomLayers.map((layer) => [
                layer.id,
                randomize
                    ? getRandomValue(layer.randomOpacityMin, layer.randomOpacityMax)
                    : clamp(layer.opacity, layer.randomOpacityMin, layer.randomOpacityMax)
            ]));
            const currentTotal = Array.from(values.values()).reduce((sum, value) => sum + value, 0);
            const difference = normalizedTotal - currentTotal;

            if (Math.abs(difference) > 1e-8) {
                const increasing = difference > 0;
                const capacities = randomLayers.map((layer) => {
                    const value = values.get(layer.id);
                    return increasing
                        ? layer.randomOpacityMax - value
                        : value - layer.randomOpacityMin;
                });
                const capacityTotal = capacities.reduce((sum, capacity) => sum + capacity, 0);
                if (capacityTotal > 0) {
                    randomLayers.forEach((layer, index) => {
                        const share = Math.abs(difference) * capacities[index] / capacityTotal;
                        values.set(layer.id, values.get(layer.id) + (increasing ? share : -share));
                    });
                }
            }

            return { total: normalizedTotal, values };
        }

        function applyRandomOpacityTotal() {
            const randomLayers = getRandomOpacityLayers();
            if (randomOpacityTotal === null || randomLayers.length === 0) return;

            const current = distributeOpacityTotal(randomLayers, randomOpacityTotal);
            const targets = distributeOpacityTotal(randomLayers, current.total, true);
            randomOpacityTotal = current.total;
            layers = layers.map((layer) => {
                if (!current.values.has(layer.id)) return layer;
                return {
                    ...layer,
                    opacity: current.values.get(layer.id),
                    randomTargets: {
                        ...layer.randomTargets,
                        opacity: targets.values.get(layer.id)
                    }
                };
            });
            syncLayerOpacitySettings();
        }

        function setRandomOpacityTotal(value) {
            if (String(value).trim() === "") {
                randomOpacityTotal = null;
                layers = layers.map((layer) => ({
                    ...layer,
                    randomTargets: {
                        ...layer.randomTargets,
                        opacity: layer.opacity
                    }
                }));
                syncLayerOpacitySettings();
                render();
                return;
            }

            const percentage = Number(value);
            if (!Number.isFinite(percentage)) return;
            randomOpacityTotal = Math.max(0, percentage / 100);
            applyRandomOpacityTotal();
            render();
        }

        function setAutoRandom(id, selection) {
            layers = layers.map((layer) => {
                if (layer.id !== id) return layer;
                const enabled = selection !== RANDOM_OFF;
                const autoRandomType = mode === MODE_OVERLAY && enabled
                    ? selection
                    : layer.autoRandomType;
                const opacity = mode === MODE_OVERLAY && enabled
                    ? clamp(
                        layer.opacity,
                        layer.randomOpacityMin,
                        layer.randomOpacityMax
                    )
                    : layer.opacity;
                return {
                    ...layer,
                    opacity,
                    autoRandom: enabled,
                    autoRandomType,
                    randomTargets: {
                        opacity,
                        morphWeight: layer.morphWeight
                    }
                };
            });
            syncLayerOpacitySettings();
            applyRandomOpacityTotal();
            render();
        }

        function setRandomOpacityBounds(id, minValue, maxValue) {
            let min = Number(minValue);
            let max = Number(maxValue);
            if (!Number.isFinite(min) || !Number.isFinite(max)) return;

            min = clamp(min, 0, 100) / 100;
            max = clamp(max, 0, 100) / 100;
            if (min > max) [min, max] = [max, min];

            const layerIndex = layers.findIndex((layer) => layer.id === id);
            if (layerIndex === -1) return;
            const setting = getLayerOpacitySetting(layerIndex);
            setting.min = min;
            setting.max = max;

            layers = layers.map((layer) => {
                if (layer.id !== id) return layer;
                const opacity = clamp(layer.opacity, min, max);
                return {
                    ...layer,
                    opacity,
                    randomOpacityMin: min,
                    randomOpacityMax: max,
                    randomTargets: {
                        ...layer.randomTargets,
                        opacity
                    }
                };
            });
            syncLayerOpacitySettings();
            applyRandomOpacityTotal();
            render();
        }

        function disposeLayer(layer) {
            if (!layer) return;
            if (layer.mediaType === "video") layer.image.pause();
            layer.stageElement?.remove();
            if (layer.objectUrl) URL.revokeObjectURL(layer.objectUrl);
        }

        function removeLayer(id) {
            disposeLayer(layers.find((layer) => layer.id === id));
            layers = layers.filter((layer) => layer.id !== id);
            applyLayerOpacitySettings();
            if (!layers.some((layer) => layer.id === alignmentReferenceId && layer.landmarks)) {
                alignmentReferenceId = layers.find((layer) => layer.landmarks)?.id || null;
            }
            applyRandomOpacityTotal();
            render();
        }

        function reorderByDrop(targetId) {
            if (!draggedId || draggedId === targetId) return;

            const draggedIndex = layers.findIndex((layer) => layer.id === draggedId);
            const targetIndex = layers.findIndex((layer) => layer.id === targetId);
            if (draggedIndex === -1 || targetIndex === -1) return;

            const next = [...layers];
            const [draggedLayer] = next.splice(draggedIndex, 1);
            next.splice(targetIndex, 0, draggedLayer);
            const hierarchySnapshot = mode === MODE_OVERLAY ? createHierarchySnapshot() : null;
            layers = next;
            applyLayerOpacitySettings();
            render();
            crossfadeHierarchy(hierarchySnapshot);
        }

        function averagePoint(points) {
            const sum = points.reduce((total, point) => ({
                x: total.x + point.x,
                y: total.y + point.y
            }), { x: 0, y: 0 });

            return {
                x: sum.x / points.length,
                y: sum.y / points.length
            };
        }

        function mergeBounds(boundsList) {
            return boundsList.reduce((result, bounds) => ({
                left: Math.min(result.left, bounds.left),
                top: Math.min(result.top, bounds.top),
                right: Math.max(result.right, bounds.right),
                bottom: Math.max(result.bottom, bounds.bottom)
            }));
        }

        function getContainTransform(layer) {
            const scale = Math.min(stage.clientWidth / layer.width, stage.clientHeight / layer.height);
            return {
                a: scale,
                b: 0,
                c: 0,
                d: scale,
                e: (stage.clientWidth - layer.width * scale) / 2,
                f: (stage.clientHeight - layer.height * scale) / 2
            };
        }

        function transformPoint(point, transform) {
            return {
                x: transform.a * point.x + transform.c * point.y + transform.e,
                y: transform.b * point.x + transform.d * point.y + transform.f
            };
        }

        function getComparableLandmarks(source, target) {
            return ALIGN_LANDMARKS
                .filter((index) => source[index] && target[index])
                .map((index) => ({
                    source: source[index],
                    target: target[index]
                }));
        }

        function getSimilarityTransform(sourceLandmarks, targetLandmarks) {
            const pairs = getComparableLandmarks(sourceLandmarks, targetLandmarks);
            if (pairs.length < 2) return null;

            const sourceCenter = averagePoint(pairs.map((pair) => pair.source));
            const targetCenter = averagePoint(pairs.map((pair) => pair.target));

            const fit = pairs.reduce((sum, pair) => {
                const sx = pair.source.x - sourceCenter.x;
                const sy = pair.source.y - sourceCenter.y;
                const tx = pair.target.x - targetCenter.x;
                const ty = pair.target.y - targetCenter.y;
                return {
                    dot: sum.dot + sx * tx + sy * ty,
                    cross: sum.cross + sx * ty - sy * tx,
                    size: sum.size + sx * sx + sy * sy
                };
            }, { dot: 0, cross: 0, size: 0 });

            if (fit.size === 0) return null;

            const a = fit.dot / fit.size;
            const b = fit.cross / fit.size;
            return {
                a,
                b,
                c: -b,
                d: a,
                e: targetCenter.x - a * sourceCenter.x + b * sourceCenter.y,
                f: targetCenter.y - b * sourceCenter.x - a * sourceCenter.y
            };
        }

        function getAlignedTransforms() {
            let transforms;
            if (!alignmentEnabled) {
                transforms = new Map(layers.map((layer) => [layer.id, getContainTransform(layer)]));
            } else {
                let reference = layers.find((layer) => (
                    layer.id === alignmentReferenceId && layer.landmarks
                ));
                if (!reference) {
                    reference = layers.find((layer) => layer.landmarks);
                    alignmentReferenceId = reference?.id || null;
                }
                const referenceTransform = reference ? getContainTransform(reference) : null;
                const referenceLandmarks = reference?.landmarks?.map((point) => transformPoint(point, referenceTransform));

                transforms = new Map(layers.map((layer) => {
                    if (!reference || layer.id === reference.id || !layer.landmarks) {
                        return [layer.id, getContainTransform(layer)];
                    }

                    return [
                        layer.id,
                        getSimilarityTransform(layer.landmarks, referenceLandmarks) || getContainTransform(layer)
                    ];
                }));
            }

            return transforms;
        }

        function getTransformedBounds(layer, transform) {
            const corners = [
                { x: 0, y: 0 },
                { x: layer.width, y: 0 },
                { x: layer.width, y: layer.height },
                { x: 0, y: layer.height }
            ].map((point) => transformPoint(point, transform));

            return corners.reduce((bounds, point) => ({
                left: Math.min(bounds.left, point.x),
                top: Math.min(bounds.top, point.y),
                right: Math.max(bounds.right, point.x),
                bottom: Math.max(bounds.bottom, point.y)
            }), {
                left: Infinity,
                top: Infinity,
                right: -Infinity,
                bottom: -Infinity
            });
        }

        function updateStageImageArea(transforms) {
            if (layers.length === 0) {
                stageImageArea.hidden = true;
                return;
            }

            const area = mergeBounds(layers.map((layer) => getTransformedBounds(layer, transforms.get(layer.id))));

            stageImageArea.hidden = false;
            stageImageArea.style.left = `${area.left}px`;
            stageImageArea.style.top = `${area.top}px`;
            stageImageArea.style.width = `${area.right - area.left}px`;
            stageImageArea.style.height = `${area.bottom - area.top}px`;
        }

        function getOverlayOpacity(layer, drawIndex) {
            return averageBlendEnabled ? 1 / (drawIndex + 1) : layer.opacity;
        }

        function createStageMedia(layer, transform, opacity) {
            let media = layer.stageElement;
            if (!media) {
                media = layer.mediaType === "video" ? layer.image : document.createElement("img");
                media.className = "stageLayer";
                media.dataset.layerId = layer.id;
                if (layer.mediaType === "video") {
                    media.muted = true;
                    media.loop = true;
                    media.autoplay = true;
                    media.playsInline = true;
                } else {
                    media.src = layer.src;
                    media.alt = layer.name;
                }
                layer.stageElement = media;
            }

            media.style.width = `${layer.width}px`;
            media.style.height = `${layer.height}px`;
            media.style.opacity = opacity;
            media.style.transformOrigin = "0 0";
            media.style.transform = `matrix(${transform.a}, ${transform.b}, ${transform.c}, ${transform.d}, ${transform.e}, ${transform.f})`;
            media.classList.toggle("is-monochrome", monochromeEnabled);
            if (layer.mediaType === "video") media.play().catch(() => {});
            return media;
        }

        function getMorphLayers() {
            return layers.filter((layer) => layer.morph);
        }

        function getNormalizedMorphWeights(morphLayers = getMorphLayers()) {
            const total = morphLayers.reduce((sum, layer) => sum + Math.max(0, layer.morphWeight), 0);
            if (total === 0) return new Map(morphLayers.map((layer) => [layer.id, 0]));

            return new Map(morphLayers.map((layer) => [
                layer.id,
                Math.max(0, layer.morphWeight) / total
            ]));
        }

        function getAutoRandomConfig(layer) {
            if (mode === MODE_MORPH) {
                if (!layer.morph) return null;
                return {
                    type: RANDOM_MORPH,
                    valueKey: "morphWeight",
                    targetKey: "morphWeight",
                    min: 0,
                    max: 100,
                    threshold: 1
                };
            }

            return {
                type: RANDOM_OPACITY,
                valueKey: "opacity",
                targetKey: "opacity",
                min: layer.randomOpacityMin,
                max: layer.randomOpacityMax,
                threshold: 0.01
            };
        }

        function getRandomValue(min, max) {
            return min + Math.random() * (max - min);
        }

        function shuffleLayerHierarchy() {
            if (layers.length < 2) return false;

            const firstIndex = Math.floor(Math.random() * layers.length);
            let secondIndex = Math.floor(Math.random() * (layers.length - 1));
            if (secondIndex >= firstIndex) secondIndex += 1;

            [layers[firstIndex], layers[secondIndex]] = [layers[secondIndex], layers[firstIndex]];
            applyLayerOpacitySettings();
            return true;
        }

        function createHierarchySnapshot() {
            const { width, height } = getRoundedStageSize();
            const canvas = document.createElement("canvas");
            const ctx = prepareCanvas(canvas, width, height);
            const transforms = getAlignedTransforms();
            const area = mergeBounds(layers.map((layer) => (
                getTransformedBounds(layer, transforms.get(layer.id))
            )));

            canvas.className = "hierarchyTransitionLayer";
            canvas.setAttribute("aria-hidden", "true");
            canvas.style.width = `${width}px`;
            canvas.style.height = `${height}px`;

            ctx.fillStyle = "#fff";
            ctx.fillRect(area.left, area.top, area.right - area.left, area.bottom - area.top);
            drawOverlayLayers(ctx, transforms);

            return canvas;
        }

        function drawOverlayLayers(ctx, transforms, offset = { x: 0, y: 0 }) {
            layers.slice().reverse().forEach((layer, drawIndex) => {
                const transform = transforms.get(layer.id);
                if (!transform || !layer.image) return;

                ctx.save();
                ctx.globalAlpha = getOverlayOpacity(layer, drawIndex);
                ctx.filter = monochromeEnabled ? "grayscale(1)" : "none";
                ctx.setTransform(
                    transform.a,
                    transform.b,
                    transform.c,
                    transform.d,
                    transform.e - offset.x,
                    transform.f - offset.y
                );
                ctx.drawImage(layer.image, 0, 0, layer.width, layer.height);
                ctx.restore();
            });
        }

        function crossfadeHierarchy(snapshot) {
            if (!snapshot) return;

            stage.querySelectorAll(".hierarchyTransitionLayer").forEach((layer) => layer.remove());
            stage.appendChild(snapshot);
            const duration = Math.min(
                HIERARCHY_CROSSFADE_DURATION,
                Math.max(80, hierarchyShuffleInterval * 0.7)
            );
            const transition = {
                snapshot,
                startTime: performance.now(),
                duration
            };
            activeHierarchyTransition = transition;
            const animation = snapshot.animate(
                [{ opacity: 1 }, { opacity: 0 }],
                {
                    duration,
                    easing: "cubic-bezier(0.45, 0, 0.55, 1)",
                    fill: "forwards"
                }
            );
            animation.finished
                .catch(() => {})
                .finally(() => {
                    snapshot.remove();
                    if (activeHierarchyTransition === transition) {
                        activeHierarchyTransition = null;
                    }
                });
        }

        function cubicBezierValueForProgress(progress, x1, y1, x2, y2) {
            const coordinate = (t, p1, p2) => {
                const inverse = 1 - t;
                return 3 * inverse * inverse * t * p1
                    + 3 * inverse * t * t * p2
                    + t * t * t;
            };
            let low = 0;
            let high = 1;
            let t = progress;

            for (let index = 0; index < 12; index += 1) {
                t = (low + high) / 2;
                if (coordinate(t, x1, x2) < progress) {
                    low = t;
                } else {
                    high = t;
                }
            }

            return coordinate(t, y1, y2);
        }

        function getHierarchyTransitionOpacity(timestamp = performance.now()) {
            if (!activeHierarchyTransition) return 0;
            const progress = clamp(
                (timestamp - activeHierarchyTransition.startTime) / activeHierarchyTransition.duration,
                0,
                1
            );
            if (progress >= 1) {
                activeHierarchyTransition = null;
                return 0;
            }
            const easedProgress = cubicBezierValueForProgress(progress, 0.45, 0, 0.55, 1);
            return 1 - easedProgress;
        }

        function hasActiveAutoRandomLayer() {
            return runtimeActive && (
                layers.some((layer) => layer.autoRandom && getAutoRandomConfig(layer))
                || (mode === MODE_OVERLAY && hierarchyShuffleEnabled && layers.length > 1)
            );
        }

        function tickAutoRandom(timestamp) {
            if (!runtimeActive) {
                autoRandomFrameId = null;
                lastAutoRandomTime = 0;
                return;
            }
            if (lastAutoRandomTime && timestamp - lastAutoRandomTime < 1000 / AUTO_RANDOM_FPS) {
                autoRandomFrameId = requestAnimationFrame(tickAutoRandom);
                return;
            }
            if (!lastAutoRandomTime) lastAutoRandomTime = timestamp;
            const deltaSeconds = Math.min((timestamp - lastAutoRandomTime) / 1000, 0.08);
            lastAutoRandomTime = timestamp;

            const totalRandomLayers = randomOpacityTotal === null ? [] : getRandomOpacityLayers();
            let coordinatedOpacityTargets = null;
            if (totalRandomLayers.length > 0) {
                const range = getRandomOpacityTotalRange(totalRandomLayers);
                randomOpacityTotal = clamp(randomOpacityTotal, range.min, range.max);
                const existingTargets = new Map(totalRandomLayers.map((layer) => [
                    layer.id,
                    layer.randomTargets?.opacity
                ]));
                const targetsValid = totalRandomLayers.every((layer) => {
                    const target = existingTargets.get(layer.id);
                    return typeof target === "number"
                        && target >= layer.randomOpacityMin - 1e-8
                        && target <= layer.randomOpacityMax + 1e-8;
                }) && Math.abs(
                    Array.from(existingTargets.values()).reduce((sum, value) => sum + value, 0)
                    - randomOpacityTotal
                ) < 1e-6;
                const allReached = targetsValid && totalRandomLayers.every((layer) => (
                    Math.abs(layer.opacity - existingTargets.get(layer.id)) <= 0.01
                ));
                coordinatedOpacityTargets = !targetsValid || allReached
                    ? distributeOpacityTotal(totalRandomLayers, randomOpacityTotal, true).values
                    : existingTargets;
            }

            let changed = false;
            layers = layers.map((layer) => {
                if (!layer.autoRandom) return layer;

                const config = getAutoRandomConfig(layer);
                if (!config) return layer;

                const currentValue = layer[config.valueKey];
                let targetValue = coordinatedOpacityTargets?.has(layer.id)
                    ? coordinatedOpacityTargets.get(layer.id)
                    : layer.randomTargets?.[config.targetKey];
                if (!coordinatedOpacityTargets
                    && (typeof targetValue !== "number" || Math.abs(currentValue - targetValue) <= config.threshold)) {
                    targetValue = getRandomValue(config.min, config.max);
                }

                const nextValue = currentValue + (targetValue - currentValue) * Math.min(deltaSeconds * 0.8, 1);
                if (Math.abs(nextValue - currentValue) < 0.0001) return layer;

                changed = true;
                return {
                    ...layer,
                    [config.valueKey]: nextValue,
                    randomTargets: {
                        ...layer.randomTargets,
                        [config.targetKey]: targetValue
                    }
                };
            });
            syncLayerOpacitySettings();

            let hierarchyChanged = false;
            let hierarchySnapshot = null;
            if (mode === MODE_OVERLAY && hierarchyShuffleEnabled && layers.length > 1) {
                if (!nextHierarchyShuffleTime) {
                    nextHierarchyShuffleTime = timestamp + hierarchyShuffleInterval;
                } else if (timestamp >= nextHierarchyShuffleTime) {
                    hierarchySnapshot = createHierarchySnapshot();
                    hierarchyChanged = shuffleLayerHierarchy();
                    nextHierarchyShuffleTime = timestamp + hierarchyShuffleInterval;
                }
            }
            changed = hierarchyChanged || changed;

            if (changed) {
                renderStage();
                if (hierarchyChanged) {
                    crossfadeHierarchy(hierarchySnapshot);
                    renderLayerList();
                }
                renderLayerOutputs();
            }

            if (hasActiveAutoRandomLayer()) {
                autoRandomFrameId = requestAnimationFrame(tickAutoRandom);
            } else {
                autoRandomFrameId = null;
                lastAutoRandomTime = 0;
            }
        }

        function ensureAutoRandomLoop() {
            if (autoRandomFrameId || !hasActiveAutoRandomLayer()) return;
            lastAutoRandomTime = 0;
            autoRandomFrameId = requestAnimationFrame(tickAutoRandom);
        }

        function getExpandedTriangle(tri, expandPx = TRIANGLE_OVERDRAW_PX) {
            const centroidX = (tri[0][0] + tri[1][0] + tri[2][0]) / 3;
            const centroidY = (tri[0][1] + tri[1][1] + tri[2][1]) / 3;

            return tri.map(([x, y]) => {
                const dx = x - centroidX;
                const dy = y - centroidY;
                const length = Math.hypot(dx, dy);
                if (length < 1e-6) return [x, y];

                const scale = (length + expandPx) / length;
                return [
                    centroidX + dx * scale,
                    centroidY + dy * scale
                ];
            });
        }

        function clipTriangle(ctx, tri) {
            const expandedTri = getExpandedTriangle(tri);
            ctx.beginPath();
            ctx.moveTo(expandedTri[0][0], expandedTri[0][1]);
            ctx.lineTo(expandedTri[1][0], expandedTri[1][1]);
            ctx.lineTo(expandedTri[2][0], expandedTri[2][1]);
            ctx.closePath();
            ctx.clip();
        }

        function drawTriangleImage(ctx, image, srcTri, dstTri) {
            const [sx0, sy0] = srcTri[0];
            const [sx1, sy1] = srcTri[1];
            const [sx2, sy2] = srcTri[2];
            const [dx0, dy0] = dstTri[0];
            const [dx1, dy1] = dstTri[1];
            const [dx2, dy2] = dstTri[2];
            const denom = sx0 * (sy1 - sy2) + sx1 * (sy2 - sy0) + sx2 * (sy0 - sy1);
            if (Math.abs(denom) < 1e-6) return;

            const a = (dx0 * (sy1 - sy2) + dx1 * (sy2 - sy0) + dx2 * (sy0 - sy1)) / denom;
            const b = (dy0 * (sy1 - sy2) + dy1 * (sy2 - sy0) + dy2 * (sy0 - sy1)) / denom;
            const c = (dx0 * (sx2 - sx1) + dx1 * (sx0 - sx2) + dx2 * (sx1 - sx0)) / denom;
            const d = (dy0 * (sx2 - sx1) + dy1 * (sx0 - sx2) + dy2 * (sx1 - sx0)) / denom;
            const e = (dx0 * (sx1 * sy2 - sx2 * sy1) + dx1 * (sx2 * sy0 - sx0 * sy2) + dx2 * (sx0 * sy1 - sx1 * sy0)) / denom;
            const f = (dy0 * (sx1 * sy2 - sx2 * sy1) + dy1 * (sx2 * sy0 - sx0 * sy2) + dy2 * (sx0 * sy1 - sx1 * sy0)) / denom;

            ctx.save();
            clipTriangle(ctx, dstTri);
            ctx.setTransform(a, b, c, d, e, f);
            ctx.drawImage(image, 0, 0);
            ctx.restore();
        }

        function blendPoints(weightedLayers) {
            const pointCount = weightedLayers[0].layer.morph.points.length;
            const points = [];

            for (let pointIndex = 0; pointIndex < pointCount; pointIndex += 1) {
                const point = weightedLayers.reduce((sum, item) => {
                    const sourcePoint = item.layer.morph.points[pointIndex];
                    return [
                        sum[0] + sourcePoint[0] * item.weight,
                        sum[1] + sourcePoint[1] * item.weight
                    ];
                }, [0, 0]);
                points.push(point);
            }

            return points;
        }

        function prepareCanvas(targetCanvas, width, height) {
            targetCanvas.width = width;
            targetCanvas.height = height;
            const ctx = targetCanvas.getContext("2d");
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = "high";
            ctx.clearRect(0, 0, width, height);
            return ctx;
        }

        function clamp(value, min, max) {
            return Math.max(min, Math.min(max, value));
        }

        function syncToggleButton(button, enabled) {
            button.classList.toggle("is-off", !enabled);
            button.setAttribute("aria-pressed", String(enabled));
        }

        function syncModeTab(button, selected) {
            button.classList.toggle("is-active", selected);
            button.setAttribute("aria-selected", String(selected));
        }

        function getStagePoint(event) {
            const bounds = stage.getBoundingClientRect();
            return {
                x: clamp(event.clientX - bounds.left, 0, bounds.width),
                y: clamp(event.clientY - bounds.top, 0, bounds.height)
            };
        }

        function getCropRect(start, end) {
            const left = Math.min(start.x, end.x);
            const top = Math.min(start.y, end.y);
            return {
                left,
                top,
                width: Math.abs(end.x - start.x),
                height: Math.abs(end.y - start.y)
            };
        }

        function normalizeCropRect(rect) {
            const { width: stageWidth, height: stageHeight } = getRoundedStageSize();
            const left = clamp(Math.round(rect.left), 0, stageWidth - 1);
            const top = clamp(Math.round(rect.top), 0, stageHeight - 1);
            const width = clamp(Math.round(rect.width), 1, stageWidth - left);
            const height = clamp(Math.round(rect.height), 1, stageHeight - top);
            return { left, top, width, height };
        }

        function getStageSize() {
            const bounds = stage.getBoundingClientRect();
            return {
                width: Math.max(1, bounds.width || stage.clientWidth || 1),
                height: Math.max(1, bounds.height || stage.clientHeight || 1)
            };
        }

        function getRoundedStageSize() {
            const size = getStageSize();
            return {
                width: Math.max(1, Math.round(size.width)),
                height: Math.max(1, Math.round(size.height))
            };
        }

        function ensureCanvasSize(canvas, width, height) {
            if (canvas.width !== width) canvas.width = width;
            if (canvas.height !== height) canvas.height = height;
        }

        function rectToCropRatio(rect) {
            const size = getStageSize();
            return {
                left: rect.left / size.width,
                top: rect.top / size.height,
                width: rect.width / size.width,
                height: rect.height / size.height
            };
        }

        function ratioToCropRect(ratio) {
            const size = getStageSize();
            return normalizeCropRect({
                left: ratio.left * size.width,
                top: ratio.top * size.height,
                width: ratio.width * size.width,
                height: ratio.height * size.height
            });
        }

        function refreshCropRectFromRatio() {
            if (!activeCropRatio) return;
            activeCropRect = ratioToCropRect(activeCropRatio);
            syncCropInputs(activeCropRect);
            if (cropEnabled) {
                updateCropSelection(activeCropRect);
            }
            if (cropPopup && !cropPopup.closed) {
                ensureCropPopupLoop();
            }
        }

        function isPointInCropRect(point, rect) {
            return point.x >= rect.left
                && point.x <= rect.left + rect.width
                && point.y >= rect.top
                && point.y <= rect.top + rect.height;
        }

        function updateCropSelection(rect) {
            cropSelection.hidden = false;
            cropSelection.style.left = `${rect.left}px`;
            cropSelection.style.top = `${rect.top}px`;
            cropSelection.style.width = `${rect.width}px`;
            cropSelection.style.height = `${rect.height}px`;
        }

        function hideCropSelection() {
            cropSelection.hidden = true;
        }

        function syncCropInputs(rect) {
            cropXInput.value = String(Math.round(rect.left));
            cropYInput.value = String(Math.round(rect.top));
            cropWidthInput.value = String(Math.round(rect.width));
            cropHeightInput.value = String(Math.round(rect.height));
        }

        function updateCropInputLimits() {
            const { width: stageWidth, height: stageHeight } = getRoundedStageSize();
            cropXInput.max = String(stageWidth - 1);
            cropYInput.max = String(stageHeight - 1);
            cropWidthInput.max = String(stageWidth);
            cropHeightInput.max = String(stageHeight);
        }

        function setActiveCropRect(rect, options = {}) {
            activeCropRect = normalizeCropRect(rect);
            if (options.updateRatio !== false) {
                activeCropRatio = rectToCropRatio(activeCropRect);
            }
            if (options.syncInputs !== false) {
                syncCropInputs(activeCropRect);
            }
            if (cropEnabled || options.showSelection) {
                updateCropSelection(activeCropRect);
            }
            if (cropPopup && !cropPopup.closed) {
                ensureCropPopupLoop();
            }
        }

        function getRectFromCropInputs() {
            const fallback = activeCropRect || getDefaultCropRect();
            const readNumber = (input, fallbackValue) => {
                const value = Number(input.value);
                return Number.isFinite(value) ? value : fallbackValue;
            };
            return normalizeCropRect({
                left: readNumber(cropXInput, fallback.left),
                top: readNumber(cropYInput, fallback.top),
                width: readNumber(cropWidthInput, fallback.width),
                height: readNumber(cropHeightInput, fallback.height)
            });
        }

        function getDefaultCropRect() {
            const { width: stageWidth, height: stageHeight } = getRoundedStageSize();
            const width = Math.min(270, stageWidth);
            const height = Math.min(480, stageHeight);
            return {
                left: Math.round((stageWidth - width) / 2),
                top: Math.round((stageHeight - height) / 2),
                width,
                height
            };
        }

        function getObjectFitContainRect(containerWidth, containerHeight, contentWidth, contentHeight) {
            const scale = Math.min(containerWidth / contentWidth, containerHeight / contentHeight);
            const width = contentWidth * scale;
            const height = contentHeight * scale;
            return {
                left: (containerWidth - width) / 2,
                top: (containerHeight - height) / 2,
                width,
                height
            };
        }

        function drawStageCrop(targetCanvas, rect) {
            const width = Math.max(1, Math.round(rect.width));
            const height = Math.max(1, Math.round(rect.height));
            ensureCanvasSize(targetCanvas, width, height);

            const ctx = targetCanvas.getContext("2d");
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = "medium";
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.globalAlpha = 1;
            ctx.filter = "none";
            ctx.clearRect(0, 0, width, height);
            ctx.fillStyle = "#fff";
            ctx.fillRect(0, 0, width, height);

            if (mode === MODE_MORPH) {
                const stageSize = getRoundedStageSize();
                const fit = getObjectFitContainRect(stageSize.width, stageSize.height, MORPH_WIDTH, MORPH_HEIGHT);
                ctx.filter = monochromeEnabled ? "grayscale(1)" : "none";
                ctx.drawImage(
                    morphCanvas,
                    fit.left - rect.left,
                    fit.top - rect.top,
                    fit.width,
                    fit.height
                );
                ctx.filter = "none";
                return { width, height };
            }

            const transforms = getAlignedTransforms();
            drawOverlayLayers(ctx, transforms, { x: rect.left, y: rect.top });

            const transitionOpacity = getHierarchyTransitionOpacity();
            const transitionSnapshot = activeHierarchyTransition?.snapshot;
            if (transitionSnapshot && transitionOpacity > 0) {
                ctx.save();
                ctx.globalAlpha = transitionOpacity;
                ctx.filter = "none";
                ctx.setTransform(1, 0, 0, 1, 0, 0);
                ctx.drawImage(
                    transitionSnapshot,
                    Math.round(rect.left),
                    Math.round(rect.top),
                    width,
                    height,
                    0,
                    0,
                    width,
                    height
                );
                ctx.restore();
            }

            return { width, height };
        }

        function drawCropPopupFrame() {
            const frameStartTime = performance.now();
            if (!runtimeActive || !cropPopup || cropPopup.closed || !cropPopupCanvas || !activeCropRect) {
                cropPopupFrameId = null;
                return;
            }

            const { width, height } = drawStageCrop(cropPopupCanvas, activeCropRect);
            const frameCompletedAt = performance.now();
            recordOutputFrame(frameCompletedAt);
            if (cropPopup !== window) {
                cropPopup.document.title = `トリミング範囲 ${width}x${height}`;
            }
            const elapsed = frameCompletedAt - frameStartTime;
            cropPopupFrameId = window.setTimeout(
                drawCropPopupFrame,
                Math.max(0, OUTPUT_FRAME_INTERVAL - elapsed)
            );
        }

        function getOutputStats() {
            const now = performance.now();
            return {
                fps: outputFpsStats.lastFrameAt && now - outputFpsStats.lastFrameAt < 2000
                    ? outputFpsStats.measuredFps
                    : 0,
                targetFps: OUTPUT_FPS,
                width: cropPopupCanvas?.width || 0,
                height: cropPopupCanvas?.height || 0,
                active: runtimeActive
            };
        }

        function exposeOutputApi(targetWindow) {
            targetWindow.getOverlapOutputStats = getOutputStats;
            targetWindow.setOverlapRuntimeActive = setRuntimeActive;
        }

        function stopRuntimeLoops() {
            if (autoRandomFrameId) cancelAnimationFrame(autoRandomFrameId);
            if (cropPopupFrameId) clearTimeout(cropPopupFrameId);
            autoRandomFrameId = null;
            cropPopupFrameId = null;
            lastAutoRandomTime = 0;
            resetOutputFpsStats();
        }

        function setRuntimeActive(active) {
            const nextActive = Boolean(active);
            if (runtimeActive === nextActive) return;
            runtimeActive = nextActive;

            if (!runtimeActive) {
                stopRuntimeLoops();
                return;
            }

            resetOutputFpsStats();
            renderStage();
            ensureAutoRandomLoop();
            if (cropPopup && !cropPopup.closed && cropPopupCanvas && activeCropRect) {
                ensureCropPopupLoop();
            }
        }

        exposeOutputApi(window);

        function ensureCropPopupLoop() {
            if (cropPopupFrameId) return;
            cropPopupFrameId = window.setTimeout(drawCropPopupFrame, 0);
        }

        function getCropPopupHtml(width, height) {
            return `<!DOCTYPE html>
<html lang="ja">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>トリミング範囲</title>
    <style>
        html, body {
            margin: 0;
            width: 100%;
            height: 100%;
            overflow: hidden;
            background: #fff;
        }
        canvas {
            display: block;
            width: 100vw;
            height: 100vh;
            object-fit: contain;
        }
    </style>
</head>
<body>
    <canvas id="cropCanvas" width="${width}" height="${height}"></canvas>
</body>
</html>`;
        }

        function requestCropPopupIdentifiers() {
            let normalizedCanvasId = DISPLAY_CANVAS_ID;
            while (!normalizedCanvasId) {
                const canvasId = window.prompt(
                    "ポップアップ内のCanvas IDを入力してください。",
                    cropPopupCanvasId
                );
                if (canvasId === null) return null;

                normalizedCanvasId = canvasId.trim();
                if (!normalizedCanvasId) {
                    alert("Canvas IDを入力してください。");
                }
            }

            cropPopupCanvasId = normalizedCanvasId;
            return {
                windowName: CROP_POPUP_WINDOW_NAME,
                canvasId: cropPopupCanvasId
            };
        }

        function showCropPopup(rect = activeCropRect || getDefaultCropRect()) {
            const identifiers = requestCropPopupIdentifiers();
            if (!identifiers) return;

            setActiveCropRect(rect, { showSelection: true });
            if (IS_EMBEDDED) {
                cropPopup = window;
                cropPopupCanvas = embeddedOutputCanvas;
                cropPopupCanvas.id = identifiers.canvasId;
                registerCropPopupWithManager(window, identifiers);
                ensureCropPopupLoop();
                return;
            }

            const width = Math.max(1, Math.round(activeCropRect.width));
            const height = Math.max(1, Math.round(activeCropRect.height));
            const previousPopup = cropPopup;
            const popup = window.open("", identifiers.windowName, `popup,width=${Math.min(1200, Math.max(120, width))},height=${Math.min(1000, Math.max(120, height))}`);
            if (!popup) {
                alert("ポップアップがブロックされました。ブラウザの設定でこのページのポップアップを許可してください。");
                return;
            }

            cropPopup = popup;
            popup.document.open();
            popup.document.write(getCropPopupHtml(width, height));
            popup.document.close();
            cropPopupCanvas = popup.document.getElementById("cropCanvas");
            cropPopupCanvas.id = identifiers.canvasId;
            exposeOutputApi(popup);
            if (previousPopup && previousPopup !== popup && !previousPopup.closed) {
                previousPopup.close();
            }

            const managerWindow = registerCropPopupWithManager(popup, identifiers);
            popup.addEventListener("beforeunload", () => {
                if (cropPopup === popup) {
                    try {
                        managerWindow?.unregisterCanvasSource(DISPLAY_SOURCE_ID, popup);
                    } catch (error) {
                        console.warn("Display Managerの登録解除に失敗しました", error);
                    }

                    cropPopup = null;
                    cropPopupCanvas = null;
                }
            });
            ensureCropPopupLoop();
            popup.focus();
        }

        function registerCropPopupWithManager(popup, identifiers) {
            if (!DISPLAY_SOURCE_ID) return null;

            const openerIsManager = window.opener
                && !window.opener.closed
                && typeof window.opener.registerCanvasSource === "function";
            const managerWindow = openerIsManager
                ? window.opener
                : window.parent !== window
                    ? window.parent
                    : null;

            try {
                if (
                    !managerWindow
                    || managerWindow.closed
                    || typeof managerWindow.registerCanvasSource !== "function"
                ) {
                    console.warn("Display Managerからoverlapを開いてください");
                    return null;
                }

                managerWindow.registerCanvasSource(
                    DISPLAY_SOURCE_ID,
                    popup,
                    identifiers.canvasId
                );
                return managerWindow;
            } catch (error) {
                console.warn("Display ManagerへのCanvas登録に失敗しました", error);
                return null;
            }
        }

        function initializeEmbeddedOutput() {
            if (!IS_EMBEDDED || !DISPLAY_SOURCE_ID || !embeddedOutputCanvas) return;
            showCropPopup(getDefaultCropRect());
            window.addEventListener("beforeunload", () => {
                try {
                    window.parent?.unregisterCanvasSource(DISPLAY_SOURCE_ID, window);
                } catch (error) {
                    console.warn("Display Managerへの登録解除に失敗しました", error);
                }
            });
        }

        function setCropEnabled(enabled) {
            cropEnabled = enabled;
            cropDrag = null;
            if (!cropEnabled) {
                hideCropSelection();
            } else if (cropEnabled) {
                setActiveCropRect(activeCropRect || getDefaultCropRect(), { showSelection: true });
            }
            stage.classList.toggle("is-cropping", cropEnabled);
            syncToggleButton(cropToggleButton, cropEnabled);
            cropControls.hidden = !cropEnabled;
        }

        function handleViewportGeometryChange() {
            renderStage();
            updateCropInputLimits();
            refreshCropRectFromRatio();
        }

        function clearDevicePixelRatioWatcher() {
            if (!devicePixelRatioQuery || !devicePixelRatioListener) return;

            if (devicePixelRatioQuery.removeEventListener) {
                devicePixelRatioQuery.removeEventListener("change", devicePixelRatioListener);
            } else {
                devicePixelRatioQuery.removeListener(devicePixelRatioListener);
            }

            devicePixelRatioQuery = null;
            devicePixelRatioListener = null;
        }

        function watchDevicePixelRatio() {
            clearDevicePixelRatioWatcher();
            const ratio = window.devicePixelRatio || 1;
            devicePixelRatioQuery = window.matchMedia(`(resolution: ${ratio}dppx)`);
            devicePixelRatioListener = () => {
                handleViewportGeometryChange();
                watchDevicePixelRatio();
            };

            if (devicePixelRatioQuery.addEventListener) {
                devicePixelRatioQuery.addEventListener("change", devicePixelRatioListener, { once: true });
            } else {
                devicePixelRatioQuery.addListener(devicePixelRatioListener);
            }
        }

        function resetCropDrag(event) {
            const pointerId = cropDrag?.pointerId;
            cropDrag = null;
            stage.classList.remove("is-crop-moving");

            if (event && pointerId !== undefined && stage.hasPointerCapture(pointerId)) {
                stage.releasePointerCapture(pointerId);
            }
        }

        function handleCropPointerDown(event) {
            if (!cropEnabled || event.button !== 0 || event.target.closest(".stageControls")) return;

            event.preventDefault();
            const point = getStagePoint(event);
            const isMovingSelection = activeCropRect && isPointInCropRect(point, activeCropRect);
            cropDrag = {
                mode: isMovingSelection ? "move" : "draw",
                pointerId: event.pointerId,
                start: point,
                current: point,
                rect: activeCropRect,
                offset: activeCropRect
                    ? {
                        x: point.x - activeCropRect.left,
                        y: point.y - activeCropRect.top
                    }
                    : null
            };
            stage.setPointerCapture(event.pointerId);

            if (isMovingSelection) {
                stage.classList.add("is-crop-moving");
                updateCropSelection(activeCropRect);
                return;
            }

            updateCropSelection(getCropRect(point, point));
        }

        function handleCropPointerMove(event) {
            if (!cropDrag || event.pointerId !== cropDrag.pointerId) return;

            cropDrag.current = getStagePoint(event);
            if (cropDrag.mode === "move" && cropDrag.rect && cropDrag.offset) {
                setActiveCropRect({
                    left: cropDrag.current.x - cropDrag.offset.x,
                    top: cropDrag.current.y - cropDrag.offset.y,
                    width: cropDrag.rect.width,
                    height: cropDrag.rect.height
                }, { showSelection: true });
                return;
            }

            updateCropSelection(getCropRect(cropDrag.start, cropDrag.current));
        }

        function handleCropPointerUp(event) {
            if (!cropDrag || event.pointerId !== cropDrag.pointerId) return;

            const dragMode = cropDrag.mode;
            const rect = dragMode === "move" && activeCropRect
                ? activeCropRect
                : getCropRect(cropDrag.start, getStagePoint(event));
            resetCropDrag(event);

            if (dragMode === "move") {
                updateCropSelection(rect);
                return;
            }

            hideCropSelection();
            if (rect.width < 8 || rect.height < 8) return;

            setActiveCropRect(rect, { showSelection: true });
            showCropPopup(rect);
        }

        function handleCropPointerCancel(event) {
            if (!cropDrag || event.pointerId !== cropDrag.pointerId) return;
            resetCropDrag(event);
            hideCropSelection();
        }

        function renderWarpedImage(targetCanvas, image, sourcePoints, destinationPoints, triangles) {
            const ctx = prepareCanvas(targetCanvas, MORPH_WIDTH, MORPH_HEIGHT);

            for (let i = 0; i < triangles.length; i += 3) {
                const i0 = triangles[i];
                const i1 = triangles[i + 1];
                const i2 = triangles[i + 2];
                drawTriangleImage(
                    ctx,
                    image,
                    [sourcePoints[i0], sourcePoints[i1], sourcePoints[i2]],
                    [destinationPoints[i0], destinationPoints[i1], destinationPoints[i2]]
                );
            }
        }

        function renderMorphStage() {
            const morphLayers = getMorphLayers();
            const normalizedWeights = getNormalizedMorphWeights(morphLayers);
            const activeMorphLayers = morphLayers
                .map((layer) => ({
                    layer,
                    weight: normalizedWeights.get(layer.id) || 0
                }))
                .filter((item) => item.weight > 0);
            const ctx = prepareCanvas(morphCanvas, MORPH_WIDTH, MORPH_HEIGHT);

            if (morphLayers.length === 0 || activeMorphLayers.length === 0) {
                return;
            }

            if (activeMorphLayers.length === 1) {
                ctx.drawImage(activeMorphLayers[0].layer.morph.canvas, 0, 0);
                return;
            }

            const blendedPoints = blendPoints(activeMorphLayers);
            const triangles = Delaunator.from(blendedPoints).triangles;
            let cumulativeWeight = 0;

            activeMorphLayers.forEach((item) => {
                const warpCanvas = document.createElement("canvas");
                renderWarpedImage(warpCanvas, item.layer.morph.canvas, item.layer.morph.points, blendedPoints, triangles);
                cumulativeWeight += item.weight;
                ctx.globalAlpha = item.weight / cumulativeWeight;
                ctx.drawImage(warpCanvas, 0, 0);
            });

            ctx.globalAlpha = 1;
        }

        function renderStage() {
            if (mode === MODE_MORPH) {
                stage.querySelectorAll(".stageLayer").forEach((media) => media.remove());
                stageImageArea.hidden = true;
                morphCanvas.hidden = false;
                morphCanvas.classList.toggle("is-monochrome", monochromeEnabled);
                renderMorphStage();
                return;
            }

            morphCanvas.hidden = true;
            morphCanvas.classList.toggle("is-monochrome", monochromeEnabled);
            const transforms = getAlignedTransforms();
            updateStageImageArea(transforms);
            const activeLayerIds = new Set(layers.map((layer) => layer.id));
            stage.querySelectorAll(".stageLayer").forEach((media) => {
                if (!activeLayerIds.has(media.dataset.layerId)) media.remove();
            });
            layers.slice().reverse().forEach((layer, drawIndex) => {
                stage.appendChild(createStageMedia(
                    layer,
                    transforms.get(layer.id),
                    getOverlayOpacity(layer, drawIndex)
                ));
            });
        }

        function renderLayerOutputs() {
            const normalizedMorphWeights = getNormalizedMorphWeights();
            layers.forEach((layer, layerIndex) => {
                const displayOpacity = getOverlayOpacity(layer, layers.length - 1 - layerIndex);
                const output = document.querySelector(`[data-opacity-output="${layer.id}"]`);
                if (output) {
                    output.value = `${Math.round(displayOpacity * 100)}%`;
                    output.textContent = output.value;
                }
                const opacityInput = document.querySelector(`[data-opacity-input="${layer.id}"]`);
                if (opacityInput) {
                    opacityInput.value = String(Math.round(displayOpacity * 100));
                    opacityInput.disabled = averageBlendEnabled;
                }

                const morphOutput = document.querySelector(`[data-morph-output="${layer.id}"]`);
                if (morphOutput) {
                    morphOutput.value = `${Math.round((normalizedMorphWeights.get(layer.id) || 0) * 100)}%`;
                    morphOutput.textContent = morphOutput.value;
                }
                const morphInput = document.querySelector(`[data-morph-input="${layer.id}"]`);
                if (morphInput) morphInput.value = String(Math.round(layer.morphWeight));
            });
        }

        function isControlTarget(target) {
            return Boolean(target.closest(".opacityControl, button, input, select"));
        }

        function preventLayerDrag(event, item) {
            event.stopPropagation();
            item.draggable = false;
        }

        function bindControlDragPrevention(control, item) {
            ["pointerdown", "mousedown", "touchstart"].forEach((eventName) => {
                control.addEventListener(eventName, (event) => preventLayerDrag(event, item));
            });
        }

        function bindLayerDrag(item, layer) {
            item.addEventListener("pointerdown", (event) => {
                item.draggable = !isControlTarget(event.target);
            });
            item.addEventListener("dragstart", (event) => {
                if (isControlTarget(event.target)) {
                    event.preventDefault();
                    item.draggable = false;
                    return;
                }

                draggedId = layer.id;
                item.classList.add("dragging");
            });
            item.addEventListener("dragend", () => {
                draggedId = null;
                item.draggable = false;
                item.classList.remove("dragging");
            });
            item.addEventListener("dragover", (event) => event.preventDefault());
            item.addEventListener("drop", (event) => {
                event.preventDefault();
                reorderByDrop(layer.id);
            });
        }

        function createIconImage(src) {
            const image = document.createElement("img");
            image.src = src;
            image.alt = "";
            image.draggable = false;
            return image;
        }

        function createRemoveButton(layer) {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "layerRemoveButton";
            button.title = "削除";
            button.setAttribute("aria-label", `${layer.name}を削除`);
            button.appendChild(createIconImage(REMOVE_ICON_SRC));
            button.addEventListener("dragstart", (event) => event.stopPropagation());
            button.addEventListener("click", (event) => {
                event.stopPropagation();
                removeLayer(layer.id);
            });
            return button;
        }

        function createThumbnail(layer) {
            const thumb = document.createElement("div");
            thumb.className = "layerThumb";

            const media = document.createElement(layer.mediaType === "video" ? "video" : "img");
            media.src = layer.src;
            media.setAttribute("aria-label", layer.name);
            media.draggable = false;
            if (layer.mediaType === "video") {
                media.muted = true;
                media.loop = true;
                media.autoplay = true;
                media.playsInline = true;
                media.play().catch(() => {});
            } else {
                media.alt = layer.name;
            }
            thumb.appendChild(media);

            return thumb;
        }

        function createLayerTitle(layer) {
            const title = document.createElement("div");
            title.className = "layerTitle";

            const fileName = document.createElement("div");
            fileName.className = "fileName";
            fileName.textContent = layer.name;
            fileName.title = layer.name;
            title.appendChild(fileName);

            return title;
        }

        function createRangeControl(layer, item, options) {
            const control = document.createElement("label");
            control.className = "opacityControl";
            bindControlDragPrevention(control, item);

            const slider = document.createElement("input");
            slider.type = "range";
            slider.min = "0";
            slider.max = "100";
            slider.value = String(options.value);
            slider.draggable = false;
            slider.disabled = Boolean(options.disabled);
            slider.dataset[options.inputDatasetKey] = layer.id;
            slider.setAttribute("aria-label", `${layer.name}の${options.label}`);
            slider.addEventListener("dragstart", (event) => event.stopPropagation());
            slider.addEventListener("input", (event) => options.onInput(layer.id, event.target.value));

            const output = document.createElement("output");
            output.dataset[options.outputDatasetKey] = layer.id;
            output.value = options.outputValue;
            output.textContent = output.value;

            control.append(slider, output);
            return control;
        }

        function createOpacityControl(layer, item) {
            const layerIndex = layers.indexOf(layer);
            const displayOpacity = getOverlayOpacity(layer, layers.length - 1 - layerIndex);
            return createRangeControl(layer, item, {
                label: "不透明度",
                value: Math.round(displayOpacity * 100),
                disabled: averageBlendEnabled,
                inputDatasetKey: "opacityInput",
                outputDatasetKey: "opacityOutput",
                outputValue: `${Math.round(displayOpacity * 100)}%`,
                onInput: setOpacity
            });
        }

        function createMorphWeightControl(layer, item) {
            return createRangeControl(layer, item, {
                label: "モーフィング割合",
                value: Math.round(layer.morphWeight),
                disabled: !layer.morph,
                inputDatasetKey: "morphInput",
                outputDatasetKey: "morphOutput",
                outputValue: "0%",
                onInput: setMorphWeight
            });
        }

        function createAutoRandomControl(layer, item) {
            const group = document.createElement("div");
            group.className = "autoControlGroup";
            const control = document.createElement("label");
            control.className = "autoControl";
            bindControlDragPrevention(group, item);

            const labelText = document.createElement("span");
            labelText.textContent = "ランダム";

            const select = document.createElement("select");
            select.draggable = false;
            select.setAttribute("aria-label", `${layer.name}のランダム変化`);

            const options = mode === MODE_MORPH
                ? [
                    [RANDOM_OFF, "停止"],
                    [RANDOM_MORPH, "モーフィング割合"]
                ]
                : [
                    [RANDOM_OFF, "停止"],
                    [RANDOM_OPACITY, "不透明度"]
                ];

            options.forEach(([value, text]) => {
                const option = document.createElement("option");
                option.value = value;
                option.textContent = text;
                select.appendChild(option);
            });

            select.value = layer.autoRandom
                ? (mode === MODE_MORPH ? RANDOM_MORPH : RANDOM_OPACITY)
                : RANDOM_OFF;
            select.addEventListener("dragstart", (event) => event.stopPropagation());
            select.addEventListener("change", (event) => setAutoRandom(layer.id, event.target.value));

            control.append(labelText, select);
            group.appendChild(control);

            if (mode === MODE_OVERLAY && layer.autoRandom) {
                const bounds = document.createElement("div");
                bounds.className = "randomOpacityBounds";

                const createBoundInput = (label, value, ariaLabel) => {
                    const bound = document.createElement("label");
                    bound.className = "randomOpacityBound";
                    const labelText = document.createElement("span");
                    labelText.textContent = label;
                    const input = document.createElement("input");
                    input.type = "number";
                    input.min = "0";
                    input.max = "100";
                    input.step = "0.1";
                    input.value = String(Math.round(value * 1000) / 10);
                    input.inputMode = "decimal";
                    input.setAttribute("aria-label", `${layer.name}の${ariaLabel}`);
                    const unit = document.createElement("span");
                    unit.textContent = "%";
                    bound.append(labelText, input, unit);
                    return { bound, input };
                };

                const minControl = createBoundInput("下限", layer.randomOpacityMin, "ランダム不透明度の下限");
                const maxControl = createBoundInput("上限", layer.randomOpacityMax, "ランダム不透明度の上限");
                const updateBounds = () => setRandomOpacityBounds(
                    layer.id,
                    minControl.input.value,
                    maxControl.input.value
                );
                minControl.input.addEventListener("change", updateBounds);
                maxControl.input.addEventListener("change", updateBounds);
                bounds.append(minControl.bound, maxControl.bound);
                group.appendChild(bounds);
            }

            return group;
        }

        function createLayerItem(layer) {
            const item = document.createElement("article");
            item.className = "layer";
            item.draggable = false;
            item.dataset.layerId = layer.id;
            bindLayerDrag(item, layer);

            const body = document.createElement("div");
            body.className = "layerBody";

            body.append(createLayerTitle(layer));
            if (mode === MODE_OVERLAY) {
                body.append(createOpacityControl(layer, item));
            } else {
                body.append(createMorphWeightControl(layer, item));
            }
            body.append(createAutoRandomControl(layer, item));
            item.append(createRemoveButton(layer), createThumbnail(layer), body);
            return item;
        }

        function renderLayerList() {
            layersContainer.replaceChildren();
            layerList.classList.toggle("has-layers", layers.length > 0);
            layers.forEach((layer) => layersContainer.appendChild(createLayerItem(layer)));
        }

        function renderStatus() {
            const randomOpacityLayers = getRandomOpacityLayers();
            const randomOpacityRange = getRandomOpacityTotalRange(randomOpacityLayers);
            updateCropInputLimits();
            status.textContent = `${layers.length} / ${MAX_IMAGES}`;
            clearButton.disabled = layers.length === 0;
            fileInput.disabled = layers.length >= MAX_IMAGES;
            addLayerSlot.hidden = layers.length >= MAX_IMAGES;
            syncToggleButton(monoToggleButton, monochromeEnabled);
            averageBlendToggleButton.hidden = mode !== MODE_OVERLAY;
            syncToggleButton(averageBlendToggleButton, averageBlendEnabled);
            alignToggleButton.hidden = mode !== MODE_OVERLAY;
            syncToggleButton(alignToggleButton, alignmentEnabled);
            hierarchyToggleButton.hidden = mode !== MODE_OVERLAY;
            syncToggleButton(hierarchyToggleButton, hierarchyShuffleEnabled);
            hierarchyIntervalControl.hidden = mode !== MODE_OVERLAY || !hierarchyShuffleEnabled;
            randomOpacityTotalControl.hidden = mode !== MODE_OVERLAY || randomOpacityLayers.length === 0;
            randomOpacityTotalInput.min = String(Math.round(randomOpacityRange.min * 1000) / 10);
            randomOpacityTotalInput.value = randomOpacityTotal === null
                ? ""
                : String(Math.round(randomOpacityTotal * 1000) / 10);
            syncModeTab(overlayModeButton, mode === MODE_OVERLAY);
            syncModeTab(morphModeButton, mode === MODE_MORPH);
        }

        function render() {
            renderStage();
            renderLayerList();
            renderLayerOutputs();
            renderStatus();
            ensureAutoRandomLoop();
        }

        function setMode(nextMode) {
            if (mode === nextMode) return;
            mode = nextMode;
            nextHierarchyShuffleTime = 0;
            render();
        }

        fileInput.addEventListener("change", async (event) => {
            await addFiles(event.target.files);
            fileInput.value = "";
        });

        clearButton.addEventListener("click", () => {
            layers.forEach(disposeLayer);
            layers = [];
            layerOpacitySettings = [];
            alignmentReferenceId = null;
            randomOpacityTotal = null;
            render();
        });

        monoToggleButton.addEventListener("click", () => {
            monochromeEnabled = !monochromeEnabled;
            render();
        });

        averageBlendToggleButton.addEventListener("click", () => {
            averageBlendEnabled = !averageBlendEnabled;
            render();
        });

        alignToggleButton.addEventListener("click", () => {
            alignmentEnabled = !alignmentEnabled;
            render();
        });

        hierarchyToggleButton.addEventListener("click", () => {
            hierarchyShuffleEnabled = !hierarchyShuffleEnabled;
            nextHierarchyShuffleTime = 0;
            renderStatus();
            ensureAutoRandomLoop();
        });

        hierarchyIntervalInput.addEventListener("input", () => {
            const seconds = Number(hierarchyIntervalInput.value);
            if (!Number.isFinite(seconds) || seconds <= 0) return;
            hierarchyShuffleInterval = Math.max(100, seconds * 1000);
            nextHierarchyShuffleTime = 0;
            ensureAutoRandomLoop();
        });

        hierarchyIntervalInput.addEventListener("change", () => {
            hierarchyIntervalInput.value = String(hierarchyShuffleInterval / 1000);
        });

        randomOpacityTotalInput.addEventListener("change", () => {
            setRandomOpacityTotal(randomOpacityTotalInput.value);
        });

        cropToggleButton.addEventListener("click", () => {
            setCropEnabled(!cropEnabled);
        });

        stage.addEventListener("pointerdown", handleCropPointerDown);
        stage.addEventListener("pointermove", handleCropPointerMove);
        stage.addEventListener("pointerup", handleCropPointerUp);
        stage.addEventListener("pointercancel", handleCropPointerCancel);

        overlayModeButton.addEventListener("click", () => setMode(MODE_OVERLAY));
        morphModeButton.addEventListener("click", () => setMode(MODE_MORPH));

        [cropXInput, cropYInput, cropWidthInput, cropHeightInput].forEach((input) => {
            input.addEventListener("input", () => {
                setActiveCropRect(getRectFromCropInputs(), {
                    syncInputs: false,
                    showSelection: true
                });
            });
            input.addEventListener("change", () => {
                setActiveCropRect(getRectFromCropInputs(), { showSelection: true });
            });
        });

        cropShowButton.addEventListener("click", () => {
            showCropPopup(getRectFromCropInputs());
        });

        const stageResizeObserver = new ResizeObserver(handleViewportGeometryChange);
        stageResizeObserver.observe(stage);
        window.addEventListener("resize", handleViewportGeometryChange);
        window.visualViewport?.addEventListener("resize", handleViewportGeometryChange);
        watchDevicePixelRatio();

        render();
        requestAnimationFrame(initializeEmbeddedOutput);
