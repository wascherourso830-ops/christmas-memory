// 单帧保守几何分类。score 表示规则匹配强度，不代表识别概率。
// 时间防抖、照片动作锁存及连续控制的启停由调用方处理；此模块不申请摄像头。
export function classifyHandPose(landmarks, aspect = 4 / 3) {
  const clamp = (value, minimum = 0, maximum = 1) => Math.max(minimum, Math.min(maximum, value));
  const fallbackCursor = { x: .5, y: .5 };
  const invalid = (reason, palmScale = 0, cursor = fallbackCursor) => ({
    pose: 'NEUTRAL', valid: false, score: 0, palmScale, cursor,
    releaseClear: false, features: { reason },
  });
  if (!Array.isArray(landmarks) || landmarks.length < 21) return invalid('missing-landmarks');
  if (!Number.isFinite(aspect) || aspect <= .2 || aspect >= 5) return invalid('invalid-aspect');
  const input = Array.from({ length: 21 }, (_, index) => landmarks[index]);
  if (input.some(point => !point || !Number.isFinite(point.x) || !Number.isFinite(point.y)
    || (point.z != null && !Number.isFinite(point.z)))) return invalid('invalid-landmark');
  if (input.some(point => Math.abs(point.x) > 4 || Math.abs(point.y) > 4 || Math.abs(point.z ?? 0) > 4)) {
    return invalid('landmark-out-of-range');
  }

  // x、z 按画面宽高比换算到以画面高度为单位的坐标，避免宽屏改变阈值。
  const depthAvailable = input.every(point => Number.isFinite(point.z));
  const points = input.map(point => ({ x: point.x * aspect, y: point.y, z: (point.z ?? 0) * aspect }));
  const subtract = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
  const dot = (a, b) => a.x * b.x + a.y * b.y;
  const cross = (a, b) => a.x * b.y - a.y * b.x;
  const length = vector => Math.hypot(vector.x, vector.y);
  const distance = (a, b) => length(subtract(a, b));
  const centroid = [0, 5, 9, 13, 17].reduce((sum, index) => ({
    x: sum.x + points[index].x / 5, y: sum.y + points[index].y / 5,
  }), { x: 0, y: 0 });
  const screenCursor = point => ({ x: clamp(1 - point.x / aspect), y: clamp(point.y) });
  const palmCursor = screenCursor(centroid);
  const palmVector = subtract(points[9], points[0]);
  const widthVector = subtract(points[17], points[5]);
  const palmScale = length(palmVector);
  const palmWidth = length(widthVector);
  if (palmScale < .025 || palmWidth < .006) return invalid('palm-too-small', palmScale, palmCursor);
  const shapeRatio = palmWidth / palmScale;
  const palmSine = Math.abs(cross(palmVector, widthVector)) / (palmScale * palmWidth);
  if (shapeRatio < .12 || shapeRatio > 3.0 || palmSine < .12) {
    return invalid('sideways-or-degenerate-palm', palmScale, palmCursor);
  }
  // 竖拇指允许适度侧掌；张掌和握拳继续要求原有的可靠掌面。
  const frontalPalm = palmWidth >= .018 && shapeRatio >= .42 && shapeRatio <= 2.6 && palmSine >= .32;

  // 以掌宽为横轴、腕到中指掌指关节为纵轴，并用掌长归一化。
  const u = { x: widthVector.x / palmWidth, y: widthVector.y / palmWidth };
  const projectedV = {
    x: palmVector.x - dot(palmVector, u) * u.x,
    y: palmVector.y - dot(palmVector, u) * u.y,
  };
  const vLength = length(projectedV);
  const v = { x: projectedV.x / vLength, y: projectedV.y / vLength };
  const local = points.map(point => {
    const offset = subtract(point, centroid);
    return { x: dot(offset, u) / palmScale, y: dot(offset, v) / palmScale, z: (point.z - points[0].z) / palmScale };
  });
  const bones = [[1, 2], [2, 3], [3, 4], [5, 6], [6, 7], [7, 8], [9, 10], [10, 11], [11, 12],
    [13, 14], [14, 15], [15, 16], [17, 18], [18, 19], [19, 20]];
  const boneLength = (a, b) => depthAvailable
    ? Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) : distance(a, b);
  if (bones.some(([a, b]) => boneLength(local[a], local[b]) < .015)) {
    return invalid('degenerate-finger', palmScale, palmCursor);
  }
  const angle = (a, b, c) => {
    const left = subtract(a, b), right = subtract(c, b);
    // 侧掌或骨段投影很短时借助深度，避免把投影重叠当成坏点或弯指。
    if (depthAvailable && (!frontalPalm || Math.min(length(left), length(right)) < .05)) {
      const lz = a.z - b.z, rz = c.z - b.z;
      const denominator = Math.hypot(left.x, left.y, lz) * Math.hypot(right.x, right.y, rz);
      return denominator < 1e-10 ? 0 : Math.acos(clamp((dot(left, right) + lz * rz) / denominator, -1, 1)) * 180 / Math.PI;
    }
    const denominator = length(left) * length(right);
    return denominator < 1e-10 ? 0 : Math.acos(clamp(dot(left, right) / denominator, -1, 1)) * 180 / Math.PI;
  };
  const fingers = [5, 9, 13, 17].map(base => {
    const pipAngle = angle(local[base], local[base + 1], local[base + 2]);
    const dipAngle = angle(local[base + 1], local[base + 2], local[base + 3]);
    const tipWrist = distance(local[base + 3], local[0]);
    const pipWrist = distance(local[base + 1], local[0]);
    const tipBase = distance(local[base + 3], local[base]);
    // 张掌允许自然弯曲；小指更短，单独放宽，但指尖仍需越过弯指位置。
    const pinky = base === 17;
    const extended = pipAngle >= (pinky ? 125 : 140) && dipAngle >= (pinky ? 120 : 135)
      && tipWrist > pipWrist * (pinky ? .99 : 1.04)
      && tipWrist >= (pinky ? 1.10 : 1.25) && tipBase >= (pinky ? .42 : .50);
    const folded = (pipAngle <= 125 && tipBase < 1.10)
      || (pipAngle < 155 && tipWrist < pipWrist * .92 && tipBase < .9);
    return { pipAngle, dipAngle, tipWrist, pipWrist, tipBase, extended, folded };
  });

  const thumbMcpAngle = angle(local[1], local[2], local[3]);
  const thumbIpAngle = angle(local[2], local[3], local[4]);
  const thumbReach = distance(local[2], local[4]);
  const thumbProximalLength = distance(local[2], local[3]);
  const thumbDistalLength = distance(local[3], local[4]);
  const thumbStraightness = thumbProximalLength + thumbDistalLength > 1e-8
    ? thumbReach / (thumbProximalLength + thumbDistalLength) : 0;
  const thumbTipPalm = length(local[4]);
  const thumbTipWrist = distance(local[4], local[0]);
  const thumbIpWrist = distance(local[3], local[0]);
  const thumbVector = subtract(points[4], points[2]);
  const distalVector = subtract(points[4], points[3]);
  // 向上以画面方向判断，不能随手掌局部坐标一起翻转。
  const upwardCosine = length(thumbVector) > 1e-8 ? -thumbVector.y / length(thumbVector) : 0;
  const distalUpwardCosine = length(distalVector) > 1e-8 ? -distalVector.y / length(distalVector) : 0;
  const upwardHeight = -thumbVector.y / palmScale;
  const aboveKnuckles = (Math.min(...[5, 9, 13, 17].map(index => points[index].y)) - points[4].y) / palmScale;
  const thumbExtended = thumbMcpAngle >= 80 && thumbIpAngle >= 145 && thumbStraightness >= .90
    && thumbReach >= .42 && thumbProximalLength >= .10 && thumbDistalLength >= .10 && thumbTipPalm >= .60;
  // 短拇指不能仅因长度较短被当成握拳，必须有靠掌身或明显折回的证据。
  const thumbRetracted = (thumbTipPalm <= .75 && thumbReach < .75)
    || (thumbIpAngle < 130 && thumbTipPalm <= .95);
  // 较短的拇指需同时更直且明显高出拳峰，避免单独降低长度后增加误触。
  const thumbRaised = (upwardHeight >= .50 && aboveKnuckles >= -.15)
    || (upwardHeight >= .28 && aboveKnuckles >= .22 && thumbStraightness >= .95 && thumbIpAngle >= 150);
  const tipGap = distance(local[4], local[8]);
  const tipContact = { x: (local[4].x + local[8].x) / 2, y: (local[4].y + local[8].y) / 2 };
  const contactWrist = distance(tipContact, local[0]);
  const ambiguousPinch = tipGap < .40 && contactWrist > .90;
  const allFolded = fingers.every(finger => finger.folded);
  const allExtended = fingers.every(finger => finger.extended);
  const thumbsUp = allFolded && thumbExtended && upwardCosine >= Math.SQRT1_2 - 1e-6
    && distalUpwardCosine >= .50 && thumbTipWrist >= 1.20 && thumbTipWrist > thumbIpWrist + .12
    && thumbRaised && tipGap >= .35;
  let pose = 'NEUTRAL', score = 0, cursor = palmCursor;
  if (thumbsUp) {
    pose = 'THUMBS_UP';
    cursor = screenCursor({ x: points[3].x * .6 + points[4].x * .4, y: points[3].y * .6 + points[4].y * .4 });
    score = .80 + .20 * (.35 * clamp((upwardCosine - Math.SQRT1_2) / (1 - Math.SQRT1_2))
      + .35 * clamp((thumbIpAngle - 145) / 35) + .30 * clamp(aboveKnuckles / .60));
  } else if (frontalPalm && allExtended && tipGap > .42) {
    pose = 'SCATTER';
    // 四指均已通过张掌条件，使用整体匹配强度，避免单个自然弯曲小指阻断控制。
    const openness = fingers.map((finger, index) => {
      const minimumPip = index === 3 ? 125 : 140;
      const minimumDip = index === 3 ? 120 : 135;
      return .6 * clamp((finger.pipAngle - minimumPip) / (180 - minimumPip))
        + .4 * clamp((finger.dipAngle - minimumDip) / (180 - minimumDip));
    });
    score = .78 + .22 * openness.reduce((sum, value) => sum + value, 0) / openness.length;
  } else if (frontalPalm && allFolded && !ambiguousPinch && !thumbExtended && thumbRetracted) {
    pose = 'TREE';
    score = .65 + .35 * Math.min(...fingers.map(finger => clamp((155 - finger.pipAngle) / 90)));
  }

  // 清楚张掌、握拳，或明确横伸/向下的拇指可释放；短暂中性过渡不解锁。
  const releaseClear = pose === 'SCATTER' || pose === 'TREE'
    || (allFolded && thumbExtended && upwardCosine <= .35);
  return {
    pose, valid: true, score: Number(score.toFixed(4)), palmScale, cursor, releaseClear,
    features: {
      shapeRatio, palmSine, frontalPalm, tipGap, contactWrist, depthAvailable,
      fingers, allFolded, allExtended, ambiguousPinch,
      thumb: { mcpAngle: thumbMcpAngle, ipAngle: thumbIpAngle, reach: thumbReach,
        proximalLength: thumbProximalLength, distalLength: thumbDistalLength,
        straightness: thumbStraightness, tipPalm: thumbTipPalm, tipWrist: thumbTipWrist, ipWrist: thumbIpWrist,
        upwardCosine, distalUpwardCosine, upwardHeight, aboveKnuckles,
        extended: thumbExtended, retracted: thumbRetracted, raised: thumbRaised, up: thumbsUp },
    },
  };
}
