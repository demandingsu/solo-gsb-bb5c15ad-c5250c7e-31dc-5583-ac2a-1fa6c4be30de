import type { RedactionBox, RedactionMap } from '../types';
import { uid } from '../types';
import { MERGE_TOLERANCE } from './scheme';

/**
 * 跨页重复区域：在当前页框选页眉 / 页脚等固定区域后，按页面宽高比例映射到
 * 页码范围内的每一页，越界部分夹取到目标页边界内；与目标页已有遮盖在
 * 0.01 点容差内相同（或夹取后退化为空矩形）的目标页跳过。
 *
 * 预览只做几何计算，不触碰现有遮盖；确认时整批仅提交一次状态更新，
 * 因此只产生一条撤销记录。全部计算均在浏览器本地完成。
 */

/** 未旋转 PDF 页面坐标下的轴对齐矩形（无 id），坐标已归一化为 x1<x2、y1<y2 */
export interface RegionRect {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface PageSize {
  width: number;
  height: number;
}

/* ------------------------------ 页码范围解析 ------------------------------ */

export interface ParsedRange {
  /** 去重并按升序排列后的目标页；解析失败时为 null */
  pages: number[] | null;
  error: string | null;
}

const RANGE_DASHES = /[-–—−－]/;
const RANGE_SEPARATORS = /[,，、]/;

/**
 * 解析页码范围输入，如 `1-3,5`、`2，4、6`、`1 – 3`。
 * 支持半角 / 中文逗号、顿号分隔；支持 - / – / — / − / － 连接的闭区间。
 * 结果去重并升序排列。页码越界、区间颠倒、无法解析均返回错误信息。
 */
export function parsePageRange(input: string, numPages: number): ParsedRange {
  const tokens = input
    .split(RANGE_SEPARATORS)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  if (tokens.length === 0) {
    return { pages: null, error: '请输入页码范围，例如 1-3,5。' };
  }

  const pages: number[] = [];
  const seen = new Set<number>();
  const push = (n: number) => {
    if (!seen.has(n)) {
      seen.add(n);
      pages.push(n);
    }
  };

  for (const token of tokens) {
    const single = /^(\d+)$/.exec(token);
    if (single) {
      const n = Number(single[1]);
      if (n < 1 || n > numPages) {
        return { pages: null, error: `页码 ${n} 超出范围（本文档共 ${numPages} 页）。` };
      }
      push(n);
      continue;
    }
    const range = new RegExp(`^(\\d+)\\s*${RANGE_DASHES.source}\\s*(\\d+)$`).exec(token);
    if (!range) {
      return { pages: null, error: `「${token}」不是有效的页码或区间，请使用如 1-3,5 的格式。` };
    }
    const lo = Number(range[1]);
    const hi = Number(range[2]);
    if (lo < 1 || hi > numPages || lo > numPages || hi < 1) {
      return { pages: null, error: `区间 ${lo}-${hi} 超出范围（本文档共 ${numPages} 页）。` };
    }
    if (lo > hi) {
      return { pages: null, error: `区间 ${lo}-${hi} 起止页颠倒，应为小编号在前。` };
    }
    for (let n = lo; n <= hi; n += 1) push(n);
  }

  pages.sort((a, b) => a - b);
  return { pages, error: null };
}

/* ------------------------------ 比例映射与夹取 ------------------------------ */

export interface MappedRegion extends RegionRect {
  /** 映射 / 夹取后至少一个坐标被修正到目标页边界内 */
  clamped: boolean;
  /** 夹取后宽或高为 0（区域完全落在页面外），无法形成遮盖 */
  degenerate: boolean;
}

const EPS = 1e-9;

/**
 * 把源页区域按宽高比例映射到目标页：
 *   x' = x / srcW * tgtW，y' = y / srcH * tgtH
 * 源区域坐标先夹到源页范围内（框选可能有极小越界），映射结果再夹到目标页
 * [0,width]×[0,height] 内；任一坐标被修正即标记 clamped。
 */
export function mapRegion(
  region: RegionRect,
  source: PageSize,
  target: PageSize,
): MappedRegion {
  const sx1 = clamp(region.x1, 0, source.width);
  const sy1 = clamp(region.y1, 0, source.height);
  const sx2 = clamp(region.x2, 0, source.width);
  const sy2 = clamp(region.y2, 0, source.height);
  const sourceClamped =
    Math.abs(sx1 - region.x1) > EPS ||
    Math.abs(sy1 - region.y1) > EPS ||
    Math.abs(sx2 - region.x2) > EPS ||
    Math.abs(sy2 - region.y2) > EPS;

  const scaleX = target.width / source.width;
  const scaleY = target.height / source.height;

  const raw = {
    x1: sx1 * scaleX,
    y1: sy1 * scaleY,
    x2: sx2 * scaleX,
    y2: sy2 * scaleY,
  };

  const mapped = {
    x1: clamp(raw.x1, 0, target.width),
    y1: clamp(raw.y1, 0, target.height),
    x2: clamp(raw.x2, 0, target.width),
    y2: clamp(raw.y2, 0, target.height),
  };

  const targetClamped =
    Math.abs(mapped.x1 - raw.x1) > EPS ||
    Math.abs(mapped.y1 - raw.y1) > EPS ||
    Math.abs(mapped.x2 - raw.x2) > EPS ||
    Math.abs(mapped.y2 - raw.y2) > EPS;

  return {
    ...mapped,
    clamped: sourceClamped || targetClamped,
    degenerate: mapped.x2 - mapped.x1 <= EPS || mapped.y2 - mapped.y1 <= EPS,
  };
}

const clamp = (v: number, min: number, max: number): number =>
  Math.min(Math.max(v, min), max);

/* ------------------------------ 预览计划 ------------------------------ */

export type SkipReason = 'duplicate' | 'degenerate';

export interface RepeatPlanItem {
  /** 目标页码（从 1 开始） */
  page: number;
  /** 映射并夹取后的预览框（PDF 页面坐标） */
  region: MappedRegion;
  /** true = 确认时将加入遮盖；false = 跳过（见 skipReason） */
  applied: boolean;
  skipReason?: SkipReason;
}

export interface RepeatPlan {
  /** 按页码升序 */
  items: RepeatPlanItem[];
  appliedPages: number[];
  skippedPages: number[];
}

/** 四个坐标差值均不超过 0.01 点即视为与已有遮盖相同 */
function sameWithinTolerance(a: RegionRect, b: RegionRect): boolean {
  return (
    Math.abs(a.x1 - b.x1) <= MERGE_TOLERANCE &&
    Math.abs(a.y1 - b.y1) <= MERGE_TOLERANCE &&
    Math.abs(a.x2 - b.x2) <= MERGE_TOLERANCE &&
    Math.abs(a.y2 - b.y2) <= MERGE_TOLERANCE
  );
}

/**
 * 对每个目标页做比例映射与夹取，并判定：
 * - 夹取后退化为空矩形（区域完全落在目标页外）→ 跳过（degenerate）；
 * - 与该页任一已有遮盖在 0.01 点容差内相同 → 跳过（duplicate）；
 * - 其余页将在确认时各加入一个遮盖框。
 * 纯函数，不修改现有遮盖。
 */
export function buildRepeatPlan(
  region: RegionRect,
  sourcePageSize: PageSize,
  pages: readonly number[],
  pageSizes: ReadonlyArray<PageSize>,
  redactions: RedactionMap,
): RepeatPlan {
  const items: RepeatPlanItem[] = pages.map((p) => {
    const mapped = mapRegion(region, sourcePageSize, pageSizes[p - 1]);
    if (mapped.degenerate) {
      return { page: p, region: mapped, applied: false, skipReason: 'degenerate' };
    }
    const duplicated = (redactions[p] ?? []).some((b) =>
      sameWithinTolerance(mapped, { x1: b.x1, y1: b.y1, x2: b.x2, y2: b.y2 }),
    );
    if (duplicated) {
      return { page: p, region: mapped, applied: false, skipReason: 'duplicate' };
    }
    return { page: p, region: mapped, applied: true };
  });

  items.sort((a, b) => a.page - b.page);
  return {
    items,
    appliedPages: items.filter((i) => i.applied).map((i) => i.page),
    skippedPages: items.filter((i) => !i.applied).map((i) => i.page),
  };
}

/**
 * 确认应用：把计划中的遮盖框追加到现有遮盖。
 * 不可变更新并只返回一个新 map（调用方一次 set 提交 = 一条撤销记录）。
 * 应用前再次按 0.01 点容差去重，避免预览后现有遮盖发生变化导致重复。
 */
export function applyRepeatPlan(
  base: RedactionMap,
  plan: RepeatPlan,
): { map: RedactionMap; added: number } {
  const map: RedactionMap = {};
  for (const key of Object.keys(base)) {
    map[Number(key)] = (base[Number(key)] ?? []).map((b) => ({ ...b }));
  }

  let added = 0;
  for (const item of plan.items) {
    if (!item.applied) continue;
    const r = item.region;
    const existing: RedactionBox[] = map[item.page] ?? [];
    if (existing.some((b) => sameWithinTolerance(r, b))) continue;
    existing.push({ id: uid(), x1: r.x1, y1: r.y1, x2: r.x2, y2: r.y2 });
    map[item.page] = existing;
    added += 1;
  }

  return { map, added };
}

/** 页码列表展示：超过 8 页时折叠为「1、2、… 等 N 页」 */
export function formatPageList(pages: readonly number[]): string {
  if (pages.length <= 8) return pages.join('、');
  return `${pages.slice(0, 8).join('、')} 等 ${pages.length} 页`;
}
