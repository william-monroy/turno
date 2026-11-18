/**
 * GLSL for the threads hero. Three passes:
 * 1. `FIELD` runs once per glyph cell and works out how much light each account's curtain
 *    puts in that cell (one channel per curtain, so tones never mix in the type).
 * 2. `BLUR` spreads those channels into a soft glow, twice: a near halo and a wide wash.
 * 3. `COMPOSITE` runs per pixel: the sky, the glow, one glyph per cell in the tone of the curtain
 *    that owns it, and over all of it the thread, a continuous line in turno's blue.
 *
 * Coordinates in the field are page heights with y up: x runs from 0 to the aspect ratio, y from
 * 0 at the bottom of the hero to 1 at its top. `u` is x over the aspect ratio (0 to 1 across).
 */

export const CURTAINS = 3;
export const PULSES = 4;
export const RECTS = 2;

/** The atlas, in a fixed order the composite indexes into. */
export const GLYPHS = [" ", ".", "'", ":", "¦", "|", "I", "H", "#", "·", "+", "─"];

export const VERTEX = `#version 300 es
void main() {
  vec2 corner = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}`;

const HASH = `
float hash1(float n) {
  n = fract(n * 0.1031);
  n *= n + 33.33;
  n *= n + n;
  return fract(n);
}

float hash2(vec2 v) {
  vec3 q = fract(vec3(v.xyx) * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

float noise1(float x) {
  float i = floor(x);
  float f = fract(x);
  return mix(hash1(i), hash1(i + 1.0), f * f * (3.0 - 2.0 * f));
}
`;

/** The thread: one smooth curve, the same in the field, the composite and the script. */
const THREAD = `
uniform vec4 uThread;

float threadY(float u) {
  return uThread.x + uThread.y * u + uThread.z * u * u;
}

float threadSlope(float u) {
  return uThread.y + 2.0 * uThread.z * u;
}
`;

export const FIELD = `#version 300 es
precision highp float;
uniform vec2 uCanvas;
uniform vec2 uCell;
uniform vec2 uOffset;
uniform float uTime;
uniform float uFade;
uniform float uDrop;
uniform float uRayFreq;
// Per curtain: centre u, half width u, edge softness u, drift u.
uniform vec4 uSpan[${CURTAINS}];
// Per curtain: hem depth under the thread at u = 0, ray height, brightness, extra depth per u.
uniform vec4 uBody[${CURTAINS}];
// Per curtain: fold depth, fold wavenumber, fold speed, phase.
uniform vec4 uFold[${CURTAINS}];
// Per pulse: u of its head, strength, unused, unused.
uniform vec4 uPulse[${PULSES}];
uniform vec4 uRects[${RECTS}];
uniform float uCalmMargin;
uniform float uStars;
// Past the copy the hems drop: from u = x to u = y, by up to z page heights; w is the floor
// they may not pass, in page heights from the bottom.
uniform vec4 uSag;
uniform sampler2D uCloth;
${THREAD}
layout(location = 0) out vec4 outCell;
layout(location = 1) out vec4 outGlow;
${HASH}

float aspect;

float sagAt(float u) {
  return uSag.z * smoothstep(uSag.x, uSag.y, u);
}

float hemAt(int i, float u) {
  vec4 body = uBody[i];
  return threadY(u) - body.x - body.w * u - sagAt(u) + uDrop;
}

float sdRect(vec2 p, vec4 r) {
  vec2 centre = (r.xy + r.zw) * 0.5;
  vec2 half_ = (r.zw - r.xy) * 0.5;
  vec2 q = abs(p - centre) - half_;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
}

// One curtain: a sheet of vertical rays hanging from a bright hem. x is where the cell is; s is
// which part of the cloth is there, after undoing the folds and the push of the pointer. Where
// the folds crowd the cloth together the sheet is seen edge on and glows brighter.
// Returns light, height within the curtain (0 at the hem), hem heat, unused.
vec4 curtain(int i, vec2 p, float t) {
  vec4 span = uSpan[i];
  vec4 body = uBody[i];
  vec4 fold = uFold[i];
  float centre = span.x + span.w * sin(t * 0.05 + fold.w * 2.3);
  float u = p.x / aspect;
  if (abs(u - centre) > span.y + span.z * 2.0 + 0.1) return vec4(0.0);

  float row = (float(i) + 0.5) / float(${CURTAINS});
  vec4 cloth = texture(uCloth, vec2(u, row));
  float restHem = hemAt(i, u);
  if (p.y < restHem - 0.12) return vec4(0.0);
  // A curtain that hangs lower is that much longer: its rays still climb past the thread.
  float tallness = body.y + 0.85 * sagAt(u);
  // Cloth hangs from above: where a hand holds it, everything below the hand moves with it and
  // the cloth above bends back toward where it hangs from, so the rays lean instead of sliding.
  float hang = exp(-max(p.y - restHem - cloth.a, 0.0) / (tallness * 0.4));
  float du = 1.5 / 160.0;
  float clothRight = texture(uCloth, vec2(u + du, row)).r;
  float clothLeft = texture(uCloth, vec2(u - du, row)).r;
  float stretch = (clothRight - clothLeft) / (2.0 * du * aspect) * hang;
  float xs = p.x - cloth.r * hang;

  float k = fold.y;
  float a1 = k * xs - fold.z * t + fold.w;
  float a2 = 2.31 * k * xs + 1.37 * fold.z * t + fold.w * 1.9;
  float a3 = 0.43 * k * xs - 0.6 * fold.z * t + fold.w * 0.7;
  float shift = fold.x * (sin(a1) + 0.4 * sin(a2) + 0.9 * sin(a3));
  float bend = fold.x * k * (cos(a1) + 0.4 * 2.31 * cos(a2) + 0.9 * 0.43 * cos(a3));
  float s = xs - shift;
  // Cloth that is crowded together shows more light per column, cloth pulled apart less.
  float crowd = clamp(1.0 / max(0.32, (1.0 + bend) * (1.0 + stretch)), 0.0, 2.6);

  float su = s / aspect;
  float ray = s * uRayFreq;
  float n1 = noise1(ray + t * 0.33 + fold.w * 5.0);
  float n2 = noise1(ray * 2.71 - t * 0.57 + 13.0 + fold.w);
  float rays = smoothstep(0.3, 0.9, n1 * 0.6 + n2 * 0.4);
  float tall = noise1(ray * 0.17 + t * 0.045 + fold.w * 3.0);
  // Ragged sides: the curtain thins out ray by ray instead of stopping at a straight edge.
  float ragged = (noise1(ray * 0.31 + fold.w * 7.0) - 0.5) * span.z * 2.2;
  float left = centre - span.y + ragged;
  float right = centre + span.y - ragged;
  // The ends of the whole band thin out slowly; where two accounts meet they hand over quickly.
  float soft = span.z * (i == 0 ? 2.4 : 1.0);
  float edge = smoothstep(left - soft, left + soft, su) * (1.0 - smoothstep(right - span.z, right + span.z, su));
  edge *= edge;
  if (edge <= 0.0) return vec4(0.0);

  // The hem meanders: where the footprint of the sheet swings away it sits higher in the sky.
  float hem = hemAt(i, su) + cloth.g + abs(cloth.r) * 0.5
    + fold.x * (0.45 * cos(a3) + 0.5 * cos(a1) + 0.22 * cos(a2))
    + 0.006 * sin(s * 21.0 + t * 0.47 + fold.w);
  float d = p.y - hem;
  float above = max(d, 0.0);
  // Where the hem falls steeply its hot border is measured across the slope, so a hem that
  // drops toward the bottom of the hero stays one continuous stroke instead of a staircase.
  float fall = (hemAt(i, su + 0.006) - hemAt(i, su - 0.006)) / (0.012 * aspect);
  float across = above / sqrt(1.0 + fall * fall);

  float reach = tallness * (0.12 + 1.15 * tall * tall) * (0.4 + 0.8 * rays);
  float column = exp(-pow(above / reach, 1.3));
  float veil = exp(-above / (tallness * 0.26));
  // The hot border is thicker in some places than others, so it never prints as a ruled line.
  float thick = 0.045 + 0.05 * noise1(ray * 0.45 - t * 0.2 + fold.w * 9.0);
  float heat = exp(-pow(across / (body.y * thick), 1.3));
  float cut = smoothstep(-0.011, 0.002, d);
  float climb = 0.82 + 0.18 * sin(d * 23.0 - t * 1.9 + ray * 0.37);

  // A message passing along the thread lights the curtain it is crossing, in the curtain's own
  // tone: the account carries the message for a moment and the message does not change.
  float carry = 0.0;
  for (int q = 0; q < ${PULSES}; q++) {
    vec4 pulse = uPulse[q];
    if (pulse.y <= 0.0) continue;
    float gap = (su - pulse.x) * aspect;
    carry += pulse.y * exp(-gap * gap / 0.006);
  }

  float light = 2.3 * edge * crowd * cut
    * ((column * (0.07 + 0.93 * rays) + veil * 0.42) * climb + heat * (0.55 + 0.45 * rays) * 1.5)
    * (1.0 + 1.1 * cloth.b + 2.4 * carry * (0.35 + 0.65 * exp(-above / (tallness * 0.6))))
    * body.z * uFade;
  // Rays thin out before they reach the top of the hero, so the light hangs in the sky
  // instead of from the edge of the page, and cloth that hangs low fades out before the rail.
  light *= mix(0.3, 1.0, smoothstep(1.0, 0.8, p.y));
  light *= mix(0.35, 1.0, smoothstep(uSag.w - 0.02, uSag.w + 0.16, p.y));
  float height = clamp(d / (tallness * 0.95), 0.0, 1.0);
  return vec4(light, height, heat * cut * edge, 0.0);
}

void main() {
  aspect = uCanvas.x / uCanvas.y;
  vec2 cell = floor(gl_FragCoord.xy);
  vec2 p = (uOffset + gl_FragCoord.xy * uCell) / uCanvas.y;
  float t = uTime;

  vec4 c0 = curtain(0, p, t);
  vec4 c1 = curtain(1, p, t);
  vec4 c2 = curtain(2, p, t);

  float calm = 0.0;
  for (int r = 0; r < ${RECTS}; r++) {
    vec4 rect = uRects[r];
    if (rect.z <= rect.x) continue;
    calm = max(calm, 1.0 - smoothstep(0.0, uCalmMargin, sdRect(p, rect)));
  }
  float keep = 1.0 - 0.93 * calm;
  vec3 lights = vec3(c0.x, c1.x, c2.x) * keep;

  // The cell takes the tone of the curtain that gives it the most light: type is never mixed.
  float owner = 0.0;
  vec4 top = c0;
  if (c1.x > top.x) { owner = 1.0; top = c1; }
  if (c2.x > top.x) { owner = 2.0; top = c2; }
  float total = lights.x + lights.y + lights.z;
  float heat = top.x > 1e-4 ? clamp(top.z, 0.0, 1.0) : 0.0;

  float star = 0.0;
  float pick = hash2(cell + 17.7);
  if (pick < uStars) {
    float b = hash2(cell * 1.9 + 4.2);
    float twinkle = 0.75 + 0.25 * sin(t * (0.7 + 1.9 * b) + pick * 700.0);
    star = (0.35 + 0.65 * b * b) * twinkle * smoothstep(0.1, 0.7, p.y) * (1.0 - 0.8 * calm) * uFade;
  }

  // Light is stored halved so the bright folds fit in 8 bit targets too.
  outCell = vec4(clamp(total * 0.5, 0.0, 1.0), (owner + clamp(top.y, 0.0, 0.99)) / 3.0, heat, star);
  outGlow = vec4(clamp(lights * 0.5, 0.0, 1.0), 1.0);
}`;

export const BLUR = `#version 300 es
precision highp float;
uniform sampler2D uSource;
uniform vec2 uStep;
out vec4 outColor;
void main() {
  vec2 uv = gl_FragCoord.xy / vec2(textureSize(uSource, 0));
  // Nine taps folded into five linear reads.
  vec4 sum = texture(uSource, uv) * 0.2270270270;
  sum += (texture(uSource, uv + uStep * 1.3846153846) + texture(uSource, uv - uStep * 1.3846153846)) * 0.3162162162;
  sum += (texture(uSource, uv + uStep * 3.2307692308) + texture(uSource, uv - uStep * 3.2307692308)) * 0.0702702703;
  outColor = sum;
}`;

export const COMPOSITE = `#version 300 es
precision highp float;
uniform sampler2D uCells;
uniform sampler2D uNear;
uniform sampler2D uWide;
uniform sampler2D uAtlas;
uniform vec2 uCanvas;
uniform vec2 uCell;
uniform vec2 uOffset;
uniform vec2 uGrid;
uniform float uAtlasCount;
uniform float uPixel;
uniform float uLight;
uniform float uFrame;
uniform float uThreadFade;
uniform vec3 uSkyLow;
uniform vec3 uSkyHigh;
uniform vec3 uTone[${CURTAINS}];
uniform vec3 uToneHot[${CURTAINS}];
uniform vec3 uToneDeep[${CURTAINS}];
uniform vec3 uKeep;
uniform vec3 uKeepHot;
uniform vec4 uPulse[${PULSES}];
${THREAD}
out vec4 outColor;
${HASH}

float glyphAt(float index, vec2 local, vec2 coord) {
  vec2 uv = vec2((index + local.x) / uAtlasCount, 1.0 - local.y);
  vec2 grad = coord / vec2(uAtlasCount, 1.0);
  return textureGrad(uAtlas, uv, dFdx(grad), dFdy(grad)).a;
}

// Rays are written with strokes that get taller and heavier with the light; only the hot hem
// earns the dense capitals.
float rayGlyph(float w, float pick) {
  if (w < 0.07) return 0.0;
  if (w < 0.15) return pick < 0.55 ? 1.0 : 2.0;
  if (w < 0.25) return 3.0;
  if (w < 0.34) return 4.0;
  return 5.0;
}

float hemGlyph(float w, float pick) {
  if (w < 0.5) return rayGlyph(w, pick);
  if (w < 0.64) return 5.0;
  if (w < 0.77) return 6.0;
  if (w < 0.89) return 7.0;
  return 8.0;
}

float glyphFor(float w, float pick, float hot) {
  return hot > 0.5 ? hemGlyph(w, pick) : rayGlyph(w, pick);
}

vec3 toSrgb(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

vec3 toneOf(int i) {
  return i == 0 ? uTone[0] : i == 1 ? uTone[1] : uTone[2];
}

vec3 hotOf(int i) {
  return i == 0 ? uToneHot[0] : i == 1 ? uToneHot[1] : uToneHot[2];
}

vec3 deepOf(int i) {
  return i == 0 ? uToneDeep[0] : i == 1 ? uToneDeep[1] : uToneDeep[2];
}

// The same hue at full strength: what an ink of that color looks like laid thin on paper.
vec3 pure(vec3 c) {
  return c / max(max(c.r, c.g), max(c.b, 1e-3));
}

void main() {
  float aspect = uCanvas.x / uCanvas.y;
  vec2 coord = (gl_FragCoord.xy - uOffset) / uCell;
  vec2 cell = floor(coord);
  vec2 local = coord - cell;
  vec4 data = texelFetch(uCells, ivec2(clamp(cell, vec2(0.0), uGrid - 1.0)), 0);
  vec3 near = texture(uNear, (coord - vec2(0.0, 0.6)) / uGrid).rgb * 2.0;
  vec3 wide = texture(uWide, (coord - vec2(0.0, 1.5)) / uGrid).rgb * 2.0;

  // The cell's owner and how high in its curtain it sits.
  float packed = data.g * 3.0;
  int owner = int(clamp(floor(packed + 0.001), 0.0, 2.0));
  float height = fract(packed + 0.001);
  float light = data.r * 2.0;
  float pick = hash2(cell * 0.83 + 2.9);
  float w = 1.0 - exp(-light * 1.15) + (hash2(cell * 1.27 + 7.1) - 0.5) * 0.06;
  float hot = data.b > 0.4 ? 1.0 : 0.0;
  // Ink on paper needs more and heavier strokes than light in the dark to carry the same weight.
  float index = glyphFor(uLight > 0.5 ? min(1.0, w * 1.55 + 0.015) : w, pick, hot);
  float star = 0.0;
  if (index < 0.5 && data.a > 0.0) {
    float b = hash2(cell * 1.9 + 4.2);
    index = b > 0.93 ? 10.0 : b > 0.6 ? 9.0 : 1.0;
    star = data.a;
  }
  float ink = index > 0.5 ? glyphAt(index, local, coord) : 0.0;
  float level = pow(clamp(w, 0.0, 1.0), 1.3);

  // The thread. Distance to the curve in device pixels, measured across its slope.
  vec2 q = gl_FragCoord.xy / uCanvas.y;
  float u = q.x / aspect;
  float slope = threadSlope(u) / aspect;
  float dist = abs(q.y - threadY(u)) / sqrt(1.0 + slope * slope) * uCanvas.y;
  float drawn = smoothstep(uThread.w + 0.004, uThread.w - 0.004, u) * uThreadFade;
  // Messages along the thread: a spark at the head and a glow that trails behind it.
  float px = uPixel;
  float paper = uLight;
  float pulse = 0.0;
  float spark = 0.0;
  // On paper: the bloom around a message, its blue ring and its white-hot centre.
  float bloom = 0.0;
  float ring = 0.0;
  float hotspot = 0.0;
  for (int k = 0; k < ${PULSES}; k++) {
    vec4 m = uPulse[k];
    if (m.y <= 0.0) continue;
    float gap = (u - m.x) * aspect;
    float tail = gap < 0.0 ? exp(gap / 0.14) : exp(-gap * gap / 0.0004);
    pulse += m.y * (exp(-gap * gap / 0.0012) + 0.45 * tail);
    vec2 head = (q - vec2(m.x * aspect, threadY(m.x))) * uCanvas.y / px;
    float r2 = dot(head, head);
    spark += m.y * (exp(-r2 / 120.0) + 0.35 * exp(-r2 / 900.0));
    float s = clamp(m.y * 1.4, 0.0, 1.0);
    bloom += m.y * (exp(-r2 / 520.0) + 0.5 * exp(-r2 / 2600.0));
    ring = max(ring, s * (1.0 - smoothstep(5.2, 6.4, sqrt(r2))));
    hotspot = max(hotspot, s * (1.0 - smoothstep(2.2, 3.4, sqrt(r2))));
  }
  // The head of the thread, while it is being drawn, burns like a message.
  if (uThread.w > -0.01 && uThread.w < 1.02) {
    vec2 head = (q - vec2(uThread.w * aspect, threadY(uThread.w))) * uCanvas.y / px;
    float r2 = dot(head, head);
    spark += uThreadFade * (exp(-r2 / 120.0) + 0.35 * exp(-r2 / 900.0));
    bloom += uThreadFade * (exp(-r2 / 520.0) + 0.5 * exp(-r2 / 2600.0));
    ring = max(ring, uThreadFade * (1.0 - smoothstep(5.2, 6.4, sqrt(r2))));
    hotspot = max(hotspot, uThreadFade * (1.0 - smoothstep(2.2, 3.4, sqrt(r2))));
  }
  // Printed, the thread needs body to hold its own against the type: a wider stroke.
  float width = mix(1.0 + 0.35 * min(pulse, 1.0), 1.25 + 0.6 * min(pulse, 1.0), paper) * px;
  float core = (1.0 - smoothstep(width - 0.6 * px, width + 0.6 * px, dist)) * drawn;
  float halo = exp(-dist * dist / (2.0 * pow(mix(4.5, 3.4, paper) * px, 2.0))) * drawn;
  float haze = exp(-dist * dist / (2.0 * pow(26.0 * px, 2.0))) * drawn;
  // The line runs in a groove: type right under it steps aside so it reads as one stroke.
  ink *= mix(1.0, smoothstep(mix(1.5, 2.6, paper) * px, mix(4.5, 6.5, paper) * px, dist), drawn);

  float lift = smoothstep(0.1, 1.0, gl_FragCoord.y / uCanvas.y);
  vec3 sky = mix(uSkyLow, uSkyHigh, lift * lift);
  vec3 color = sky;

  if (uLight < 0.5) {
    for (int i = 0; i < ${CURTAINS}; i++) {
      float n = i == 0 ? near.r : i == 1 ? near.g : near.b;
      float f = i == 0 ? wide.r : i == 1 ? wide.g : wide.b;
      color += toneOf(i) * (f * 0.11 + n * 0.2);
    }
    vec3 tint = mix(hotOf(owner), mix(toneOf(owner), deepOf(owner), smoothstep(0.35, 1.0, height)), smoothstep(0.0, 0.18, height));
    vec3 glyph = tint * (0.08 + 1.6 * level);
    vec3 starColor = vec3(0.72, 0.76, 0.86) * star * 0.55;
    color += ink * mix(glyph, starColor, step(0.001, star));
    // The thread: turno's blue, near white at its core when a message passes.
    color += uKeep * (haze * (0.07 + 0.05 * min(pulse, 1.0)) + halo * (0.35 + 0.8 * min(pulse, 1.5)));
    vec3 line = mix(uKeep * 1.25, uKeepHot, clamp(0.25 + 0.6 * pulse, 0.0, 1.0));
    color = mix(color, line, clamp(core, 0.0, 1.0));
    color += uKeepHot * spark * 0.85;
  } else {
    // On paper the curtains are printed like a risograph: each account's ink is laid down first
    // as a wash where its light is, then the type over it in the same ink at full strength. Inks
    // are translucent, so they multiply where they meet, and the drum leaves a little grain.
    vec3 sheet = color;
    float drum = 0.84 + 0.32 * hash2(floor(gl_FragCoord.xy / max(1.0, px)) + 0.5);
    // Where two washes meet their hues blend instead of darkening each other, so the band
    // changes color at the border between accounts instead of turning muddy there.
    vec3 hue = vec3(0.0);
    float amount = 0.0;
    float total = 0.0;
    for (int i = 0; i < ${CURTAINS}; i++) {
      float n = i == 0 ? near.r : i == 1 ? near.g : near.b;
      float f = i == 0 ? wide.r : i == 1 ? wide.g : wide.b;
      float wash = smoothstep(0.0, 0.55, f) * 0.3 + smoothstep(0.12, 0.85, n) * 0.3;
      hue += pure(toneOf(i)) * wash;
      total += wash;
      amount = max(amount, wash);
    }
    // The wash is mixed the way ink looks, in gamma space: a thin amber stays amber instead of
    // turning salmon, a thin green stays green instead of turning grey.
    if (total > 1e-4) {
      vec3 thin = mix(vec3(1.0), pow(hue / total, vec3(1.0 / 2.2)), clamp(amount * drum, 0.0, 0.6));
      color *= pow(thin, vec3(2.2));
    }
    // A message lights the paper around it, so the type under its bloom prints lighter.
    float glare = clamp(bloom * 0.7, 0.0, 0.75);
    vec3 inkTone = mix(toneOf(owner), deepOf(owner), hot * 0.7);
    float alpha = ink * smoothstep(0.015, 0.1, w) * (1.0 - glare);
    color *= mix(vec3(1.0), inkTone, clamp(alpha, 0.0, 1.0));
    color *= mix(vec3(1.0), uKeep, ink * star * 0.35);
    // The thread: a fine halo of blue light, then the line itself in full blue ink. Where a
    // message runs, the line turns to light: paler, wider, glowing.
    vec3 lit = mix(uKeepHot, sheet, 0.42);
    color = mix(color, lit, clamp(halo * (0.4 + 0.5 * min(pulse, 1.2)) + haze * 0.05, 0.0, 1.0));
    vec3 line = mix(uKeep, mix(uKeepHot, sheet, 0.3), clamp(0.75 * pulse, 0.0, 0.8));
    color = mix(color, line, clamp(core, 0.0, 1.0));
    // The message: a bloom of blue light on the paper, a ring of blue, a white-hot point.
    color = mix(color, mix(uKeepHot, sheet, 0.5), clamp(bloom * 0.62, 0.0, 0.85));
    color = mix(color, uKeepHot, ring);
    color = mix(color, sheet, hotspot);
  }

  // Dither before the 8 bit write so the dark sky does not band.
  float grain = hash2(gl_FragCoord.xy + uFrame * 7.13) + hash2(gl_FragCoord.xy * 1.37 + 3.1) - 1.0;
  outColor = vec4(toSrgb(color) + grain / 255.0, 1.0);
}`;
