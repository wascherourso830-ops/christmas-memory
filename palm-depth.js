// 根据掌部在画面中的大小控制远近，不使用容易随手势变化的指尖距离。
// 手远离摄像头、掌部变小：放大；手靠近摄像头、掌部变大：缩小。
export function createPalmDepth() {
  const minimumZoom = .68;
  const maximumZoom = 1.5;
  const deadZone = .04;
  let zoom = 1;
  let baseline = null;
  let filteredSize = null;
  const clamp = value => Math.max(minimumZoom, Math.min(maximumZoom, value));

  function measurePalm(landmarks, aspect) {
    if (!landmarks) return null;
    const points = [0, 5, 9, 17].map(index => landmarks[index]);
    if (points.some(point => !point || !Number.isFinite(point.x) || !Number.isFinite(point.y))) return null;
    const ratio = Number.isFinite(aspect) && aspect > .2 && aspect < 5 ? aspect : 4 / 3;
    const distance = (a, b) => Math.hypot((a.x - b.x) * ratio, a.y - b.y);
    const [wrist, indexBase, middleBase, littleBase] = points;
    const length = distance(wrist, middleBase);
    const width = distance(indexBase, littleBase);
    const diagonal = (distance(wrist, indexBase) + distance(wrist, littleBase)) / 2;
    const shapeRatio = width / length;
    // 手太远、侧掌过窄或退化骨架时不猜测深度，保持当前画面。
    if (length < .025 || width < .018 || !Number.isFinite(shapeRatio) || shapeRatio < .42 || shapeRatio > 2.6) return null;
    const size = Math.sqrt(width * (length * .7 + diagonal * .3));
    if (!Number.isFinite(size) || size < .025) return null;
    return {size, shapeRatio};
  }

  function stop() {
    baseline = null;
    filteredSize = null;
  }

  function begin(landmarks, aspect = 4 / 3, currentZoom = 1) {
    if (Number.isFinite(currentZoom)) zoom = clamp(currentZoom);
    stop();
    const palm = measurePalm(landmarks, aspect);
    if (palm) {
      baseline = {...palm, zoom};
      filteredSize = palm.size;
    }
  }

  function update(landmarks, aspect = 4 / 3, dt = 1 / 60) {
    if (!landmarks) { stop(); return zoom; }
    if (!Number.isFinite(dt) || dt <= 0) return zoom;
    const palm = measurePalm(landmarks, aspect);
    if (!palm) return zoom;
    if (!baseline) { begin(landmarks, aspect, zoom); return zoom; }
    // 明显的侧转优先视为手掌朝向变化，避免将转手误认为推拉。
    const shapeChange = palm.shapeRatio / baseline.shapeRatio;
    if (shapeChange < .7 || shapeChange > 1.45) return zoom;
    const elapsed = Math.min(dt, .05);
    filteredSize += (palm.size - filteredSize) * (1 - Math.exp(-elapsed * 16));
    const relativeSize = filteredSize / baseline.size;
    let targetZoom = baseline.zoom;
    if (Math.abs(relativeSize - 1) > deadZone + 1e-9) {
      // 扣除死区后连续映射，跨过阈值时不会突然跳大或跳小。
      const adjustedSize = relativeSize < 1 ? relativeSize + deadZone : relativeSize - deadZone;
      targetZoom = clamp(baseline.zoom * Math.pow(1 / adjustedSize, .9));
    }
    zoom += (targetZoom - zoom) * (1 - Math.exp(-elapsed * 8));
    if (Math.abs(targetZoom - zoom) < 1e-7) zoom = targetZoom;
    return zoom;
  }

  function reset(value = 1) {
    stop();
    zoom = Number.isFinite(value) ? clamp(value) : 1;
  }

  return {begin, update, stop, reset};
}
