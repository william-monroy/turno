import { SAMPLES } from "./cloth";
import type { Scene } from "./layout";
import { BLUR, COMPOSITE, CURTAINS, FIELD, GLYPHS, VERTEX } from "./shaders";

/** A glyph cell is 0.6 times as wide as it is tall: the advance of a monospace font. */
const CELL_ASPECT = 0.6;
const ATLAS_W = 48;
const ATLAS_H = 80;

interface Program {
  program: WebGLProgram;
  u: Record<string, WebGLUniformLocation | null>;
}

interface Target {
  texture: WebGLTexture;
  framebuffer: WebGLFramebuffer;
}

/** Colors in linear light, read from the theme's tokens. */
export interface Palette {
  light: boolean;
  skyLow: Float32Array;
  skyHigh: Float32Array;
  tone: Float32Array;
  toneHot: Float32Array;
  toneDeep: Float32Array;
  keep: Float32Array;
  keepHot: Float32Array;
}

export function createPalette(): Palette {
  return {
    light: false,
    skyLow: new Float32Array(3),
    skyHigh: new Float32Array(3),
    tone: new Float32Array(CURTAINS * 3),
    toneHot: new Float32Array(CURTAINS * 3),
    toneDeep: new Float32Array(CURTAINS * 3),
    keep: new Float32Array(3),
    keepHot: new Float32Array(3),
  };
}

/** What changes from frame to frame, in arrays allocated once. */
export interface Frame {
  time: number;
  fade: number;
  drop: number;
  frame: number;
  threadHead: number;
  threadFade: number;
  pulses: Float32Array;
  rects: Float32Array;
  calmMargin: number;
}

export interface Grid {
  cols: number;
  rows: number;
  cellW: number;
  cellH: number;
  offsetX: number;
  offsetY: number;
  ratio: number;
}

export interface Renderer {
  resize(width: number, height: number, cellCss: number, ratio: number): Grid;
  render(frame: Frame, cloth: Float32Array, palette: Palette): void;
  /** Ink on paper prints heavier than light in the dark: the atlas follows the theme. */
  setWeight(weight: number): void;
  dispose(): void;
}

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  return shader;
}

function link(gl: WebGL2RenderingContext, fragment: string): Program | null {
  const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX);
  const frag = compile(gl, gl.FRAGMENT_SHADER, fragment);
  const program = gl.createProgram();
  if (!vertex || !frag || !program) return null;
  gl.attachShader(program, vertex);
  gl.attachShader(program, frag);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(frag);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    if (process.env.NODE_ENV !== "production") console.warn(gl.getProgramInfoLog(program) || gl.getShaderInfoLog(frag));
    gl.deleteProgram(program);
    return null;
  }
  const u: Program["u"] = {};
  const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS) as number;
  for (let i = 0; i < count; i++) {
    const info = gl.getActiveUniform(program, i);
    if (!info) continue;
    const name = info.name.replace(/\[0\]$/, "");
    u[name] = gl.getUniformLocation(program, name);
  }
  return { program, u };
}

function makeTexture(gl: WebGL2RenderingContext, filter: number): WebGLTexture | null {
  const texture = gl.createTexture();
  if (!texture) return null;
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return texture;
}

/** One row of glyphs drawn with the page's mono font, white on transparent. */
function buildAtlas(gl: WebGL2RenderingContext, font: string, weight: number, reuse?: WebGLTexture): WebGLTexture | null {
  const canvas = document.createElement("canvas");
  canvas.width = ATLAS_W * GLYPHS.length;
  canvas.height = ATLAS_H;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.font = `${weight} ${Math.round(ATLAS_H * 0.78)}px ${font}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#fff";
  GLYPHS.forEach((glyph, i) => {
    ctx.fillText(glyph, i * ATLAS_W + ATLAS_W / 2, ATLAS_H / 2 + 2);
  });
  const texture = reuse ?? makeTexture(gl, gl.LINEAR);
  if (!texture) return null;
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  return texture;
}

export function createRenderer(gl: WebGL2RenderingContext, scene: Scene, font: string): Renderer | null {
  const field = link(gl, FIELD);
  const blur = link(gl, BLUR);
  const composite = link(gl, COMPOSITE);
  const fail = () => {
    for (const p of [field, blur, composite]) if (p) gl.deleteProgram(p.program);
    return null;
  };
  if (!field || !blur || !composite) return fail();

  // Half floats keep the faint end of the glow free of banding; bytes still work without them.
  const floats = Boolean(gl.getExtension("EXT_color_buffer_float"));
  const format = floats ? gl.RGBA16F : gl.RGBA8;
  const type = floats ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE;

  const vao = gl.createVertexArray();
  const cells = makeTexture(gl, gl.NEAREST);
  const glow = makeTexture(gl, gl.LINEAR);
  const fieldFbo = gl.createFramebuffer();
  const target = (): Target | null => {
    const texture = makeTexture(gl, gl.LINEAR);
    const framebuffer = gl.createFramebuffer();
    return texture && framebuffer ? { texture, framebuffer } : null;
  };
  const scratch = target();
  const near = target();
  const wide = target();
  const cloth = makeTexture(gl, gl.LINEAR);
  let weight = 500;
  const atlas = buildAtlas(gl, font, weight);
  if (!vao || !cells || !glow || !fieldFbo || !scratch || !near || !wide || !cloth || !atlas) return fail();
  gl.bindTexture(gl.TEXTURE_2D, cloth);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, SAMPLES, CURTAINS, 0, gl.RGBA, gl.FLOAT, null);

  const canvas = gl.canvas as HTMLCanvasElement;
  const grid: Grid = { cols: 0, rows: 0, cellW: 1, cellH: 1, offsetX: 0, offsetY: 0, ratio: 1 };

  const allocate = (texture: WebGLTexture, fbo: WebGLFramebuffer, attachment: number) => {
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, format, grid.cols, grid.rows, 0, gl.RGBA, type, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, attachment, gl.TEXTURE_2D, texture, 0);
  };

  const resize: Renderer["resize"] = (width, height, cellCss, ratio) => {
    canvas.width = Math.max(1, Math.round(width * ratio));
    canvas.height = Math.max(1, Math.round(height * ratio));
    const cellH = Math.max(6, Math.round(cellCss * ratio));
    const cellW = Math.max(4, Math.round(cellH * CELL_ASPECT));
    const cols = Math.ceil(canvas.width / cellW);
    const rows = Math.ceil(canvas.height / cellH);
    const changed = cols !== grid.cols || rows !== grid.rows;
    grid.cols = cols;
    grid.rows = rows;
    grid.cellW = cellW;
    grid.cellH = cellH;
    grid.ratio = ratio;
    grid.offsetX = Math.floor((canvas.width - cols * cellW) / 2);
    // Rows hang from the top edge, where the curtains start.
    grid.offsetY = canvas.height - rows * cellH;
    if (changed) {
      allocate(cells, fieldFbo, gl.COLOR_ATTACHMENT0);
      allocate(glow, fieldFbo, gl.COLOR_ATTACHMENT1);
      allocate(scratch.texture, scratch.framebuffer, gl.COLOR_ATTACHMENT0);
      allocate(near.texture, near.framebuffer, gl.COLOR_ATTACHMENT0);
      allocate(wide.texture, wide.framebuffer, gl.COLOR_ATTACHMENT0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
    return grid;
  };

  const blurPass = (source: WebGLTexture, into: Target, sx: number, sy: number) => {
    gl.bindFramebuffer(gl.FRAMEBUFFER, into.framebuffer);
    gl.bindTexture(gl.TEXTURE_2D, source);
    gl.uniform2f(blur.u.uStep, sx / grid.cols, sy / grid.rows);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };

  const render: Renderer["render"] = (frame, clothData, palette) => {
    if (!grid.cols) return;
    gl.bindVertexArray(vao);
    gl.disable(gl.BLEND);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, cloth);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, SAMPLES, CURTAINS, gl.RGBA, gl.FLOAT, clothData);

    gl.bindFramebuffer(gl.FRAMEBUFFER, fieldFbo);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
    gl.viewport(0, 0, grid.cols, grid.rows);
    gl.useProgram(field.program);
    const f = field.u;
    gl.uniform1i(f.uCloth, 0);
    gl.uniform2f(f.uCanvas, canvas.width, canvas.height);
    gl.uniform2f(f.uCell, grid.cellW, grid.cellH);
    gl.uniform2f(f.uOffset, grid.offsetX, grid.offsetY);
    gl.uniform1f(f.uTime, frame.time);
    gl.uniform1f(f.uFade, frame.fade);
    gl.uniform1f(f.uDrop, frame.drop);
    // A ray is always at least a whole column of type wide.
    gl.uniform1f(f.uRayFreq, canvas.height / grid.cellW / 2.4);
    gl.uniform4f(f.uThread, scene.thread[0], scene.thread[1], scene.thread[2], frame.threadHead);
    gl.uniform4fv(f.uSpan, scene.span);
    gl.uniform4fv(f.uBody, scene.body);
    gl.uniform4fv(f.uFold, scene.fold);
    gl.uniform4fv(f.uPulse, frame.pulses);
    gl.uniform4fv(f.uRects, frame.rects);
    gl.uniform1f(f.uCalmMargin, frame.calmMargin);
    gl.uniform1f(f.uStars, palette.light ? 0.004 : 0.012);
    gl.uniform4f(f.uSag, scene.sag[0], scene.sag[1], scene.sag[2], scene.sag[3]);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    gl.useProgram(blur.program);
    gl.uniform1i(blur.u.uSource, 0);
    gl.activeTexture(gl.TEXTURE0);
    blurPass(glow, scratch, 1, 0);
    blurPass(scratch.texture, near, 0, 0.7);
    blurPass(near.texture, scratch, 4, 0);
    blurPass(scratch.texture, wide, 0, 3);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.useProgram(composite.program);
    const c = composite.u;
    const bind = (unit: number, texture: WebGLTexture, name: string) => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.uniform1i(c[name] ?? null, unit);
    };
    bind(0, cells, "uCells");
    bind(1, near.texture, "uNear");
    bind(2, wide.texture, "uWide");
    bind(3, atlas, "uAtlas");
    gl.uniform2f(c.uCanvas, canvas.width, canvas.height);
    gl.uniform2f(c.uCell, grid.cellW, grid.cellH);
    gl.uniform2f(c.uOffset, grid.offsetX, grid.offsetY);
    gl.uniform2f(c.uGrid, grid.cols, grid.rows);
    gl.uniform1f(c.uAtlasCount, GLYPHS.length);
    gl.uniform1f(c.uPixel, grid.ratio);
    gl.uniform1f(c.uLight, palette.light ? 1 : 0);
    gl.uniform1f(c.uFrame, frame.frame);
    gl.uniform1f(c.uThreadFade, frame.threadFade);
    gl.uniform4f(c.uThread, scene.thread[0], scene.thread[1], scene.thread[2], frame.threadHead);
    gl.uniform4fv(c.uPulse, frame.pulses);
    gl.uniform3fv(c.uSkyLow, palette.skyLow);
    gl.uniform3fv(c.uSkyHigh, palette.skyHigh);
    gl.uniform3fv(c.uTone, palette.tone);
    gl.uniform3fv(c.uToneHot, palette.toneHot);
    gl.uniform3fv(c.uToneDeep, palette.toneDeep);
    gl.uniform3fv(c.uKeep, palette.keep);
    gl.uniform3fv(c.uKeepHot, palette.keepHot);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };

  const dispose = () => {
    for (const t of [cells, glow, scratch.texture, near.texture, wide.texture, cloth, atlas]) gl.deleteTexture(t);
    for (const fbo of [fieldFbo, scratch.framebuffer, near.framebuffer, wide.framebuffer]) gl.deleteFramebuffer(fbo);
    for (const p of [field, blur, composite]) gl.deleteProgram(p.program);
    gl.deleteVertexArray(vao);
  };

  const setWeight = (next: number) => {
    if (next === weight) return;
    weight = next;
    buildAtlas(gl, font, weight, atlas);
  };

  return { resize, render, setWeight, dispose };
}
