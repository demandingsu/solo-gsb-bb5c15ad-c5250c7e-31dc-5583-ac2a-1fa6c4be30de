import { describe, expect, it } from 'vitest';
import {
  applyRepeatPlan,
  buildRepeatPlan,
  formatPageList,
  mapRegion,
  parsePageRange,
} from './repeatRegion';
import { MERGE_TOLERANCE } from './scheme';
import type { RedactionMap } from '../types';

const LETTER = { width: 612, height: 792 };
const A4 = { width: 595.28, height: 841.89 };
const LANDSCAPE = { width: 792, height: 612 };

describe('parsePageRange', () => {
  it('单个页码', () => {
    expect(parsePageRange('3', 10)).toEqual({ pages: [3], error: null });
  });

  it('区间与逗号混合，去重并升序：1-3,5', () => {
    expect(parsePageRange('1-3,5', 10).pages).toEqual([1, 2, 3, 5]);
    expect(parsePageRange('5, 1 - 3 ,2', 10).pages).toEqual([1, 2, 3, 5]);
  });

  it('兼容中文逗号 / 顿号与各种破折号', () => {
    expect(parsePageRange('1，3、5', 10).pages).toEqual([1, 3, 5]);
    expect(parsePageRange('2–4', 10).pages).toEqual([2, 3, 4]);
    expect(parsePageRange('2—4', 10).pages).toEqual([2, 3, 4]);
    expect(parsePageRange('2−4', 10).pages).toEqual([2, 3, 4]);
  });

  it('空白输入报错', () => {
    expect(parsePageRange('   ', 10).error).toContain('页码范围');
  });

  it('无法解析的 token 报错且不给出页列表', () => {
    const r = parsePageRange('1,a,3', 10);
    expect(r.pages).toBeNull();
    expect(r.error).toContain('a');
  });

  it('页码越界、区间越界、区间颠倒均报错', () => {
    expect(parsePageRange('11', 10).error).toContain('超出范围');
    expect(parsePageRange('9-12', 10).error).toContain('超出范围');
    expect(parsePageRange('5-2', 10).error).toContain('颠倒');
  });

  it('区间端点 1 / 末页合法', () => {
    expect(parsePageRange('1-10', 10).pages).toHaveLength(10);
  });
});

describe('mapRegion 比例映射与夹取', () => {
  // 页眉：占满整宽，顶部 60 点高
  const header = { x1: 0, y1: 792 - 60, x2: 612, y2: 792 };

  it('同尺寸页面恒等映射', () => {
    const m = mapRegion(header, LETTER, LETTER);
    expect(m.x1).toBeCloseTo(0);
    expect(m.y1).toBeCloseTo(732);
    expect(m.x2).toBeCloseTo(612);
    expect(m.y2).toBeCloseTo(792);
    expect(m.clamped).toBe(false);
    expect(m.degenerate).toBe(false);
  });

  it('按目标页宽高比例映射到不同尺寸页面（页眉仍贴顶满宽）', () => {
    const m = mapRegion(header, LETTER, A4);
    expect(m.x1).toBeCloseTo(0, 5);
    expect(m.x2).toBeCloseTo(595.28, 5);
    expect(m.y2).toBeCloseTo(841.89, 5);
    expect(m.y1).toBeCloseTo(841.89 - (60 / 792) * 841.89, 5);
    expect(m.clamped).toBe(false);
  });

  it('映射到横版页面：纵向比例保持（页脚示例）', () => {
    const footer = { x1: 0, y1: 0, x2: 612, y2: 40 };
    const m = mapRegion(footer, LETTER, LANDSCAPE);
    expect(m.x1).toBeCloseTo(0, 5);
    expect(m.x2).toBeCloseTo(792, 5); // 满宽 -> 横版满宽
    expect(m.y1).toBeCloseTo(0);
    expect(m.y2).toBeCloseTo((40 / 792) * 612, 5);
    expect(m.clamped).toBe(false);
  });

  it('映射结果超出目标页边界时夹取并标记 clamped', () => {
    // 源区域覆盖右半页（比例 0.5~1）；构造更窄的目标页，理论上仍在范围内，
    // 这里直接用略微越界的源坐标验证夹取路径
    const over = { x1: -10, y1: -10, x2: 620, y2: 800 };
    const m = mapRegion(over, LETTER, LETTER);
    expect(m.x1).toBe(0);
    expect(m.y1).toBe(0);
    expect(m.x2).toBe(612);
    expect(m.y2).toBe(792);
    expect(m.clamped).toBe(true);
    expect(m.degenerate).toBe(false);
  });

  it('映射到极小目标页时整页填满，不产生退化（区域覆盖整页的情形）', () => {
    const full = { x1: 0, y1: 0, x2: 612, y2: 792 };
    const tiny = { width: 100, height: 200 };
    const m = mapRegion(full, LETTER, tiny);
    expect(m.x1).toBe(0);
    expect(m.y1).toBe(0);
    expect(m.x2).toBe(100);
    expect(m.y2).toBe(200);
    expect(m.degenerate).toBe(false);
  });
});

describe('buildRepeatPlan 预览计划', () => {
  const header = { x1: 0, y1: 732, x2: 612, y2: 792 };
  const sizes = [LETTER, A4, LANDSCAPE, LETTER];

  it('无已有遮盖时全部目标页为应用页', () => {
    const plan = buildRepeatPlan(header, LETTER, [1, 2, 3, 4], sizes, {});
    expect(plan.appliedPages).toEqual([1, 2, 3, 4]);
    expect(plan.skippedPages).toEqual([]);
    expect(plan.items[0].applied).toBe(true);
  });

  it('与已有遮盖在 0.01 点容差内相同的页跳过（duplicate）', () => {
    const redactions: RedactionMap = {
      1: [{ id: 'a', x1: 0, y1: 732, x2: 612, y2: 792 }],
      3: [
        {
          id: 'b',
          x1: 0,
          y1: 612 - (60 / 792) * 612 + MERGE_TOLERANCE / 2,
          x2: 792,
          y2: 612,
        },
      ],
    };
    const plan = buildRepeatPlan(header, LETTER, [1, 2, 3], sizes, redactions);
    expect(plan.appliedPages).toEqual([2]);
    expect(plan.skippedPages).toEqual([1, 3]);
    expect(plan.items[0].skipReason).toBe('duplicate');
    expect(plan.items[2].skipReason).toBe('duplicate');
  });

  it('坐标相差超过容差则仍需应用', () => {
    const redactions: RedactionMap = {
      1: [{ id: 'a', x1: 1, y1: 732, x2: 612, y2: 792 }],
    };
    const plan = buildRepeatPlan(header, LETTER, [1], sizes, redactions);
    expect(plan.appliedPages).toEqual([1]);
  });

  it('区域完全落在目标页外（夹取后退化）标记 degenerate', () => {
    // 源页上一个在 x=600..610 的窄竖条，映射到更窄页面时比例仍为正，
    // 这里用极小越界条：源区域被夹到一条边上（宽 0）
    const edge = { x1: 612, y1: 0, x2: 620, y2: 50 };
    const plan = buildRepeatPlan(edge, LETTER, [1, 2], sizes, {});
    expect(plan.skippedPages).toEqual([1, 2]);
    expect(plan.items.every((i) => i.skipReason === 'degenerate')).toBe(true);
  });

  it('结果按页码升序，即使输入乱序', () => {
    const plan = buildRepeatPlan(header, LETTER, [4, 1, 3], sizes, {});
    expect(plan.items.map((i) => i.page)).toEqual([1, 3, 4]);
  });

  it('不修改输入的现有遮盖', () => {
    const redactions: RedactionMap = {
      1: [{ id: 'a', x1: 1, y1: 1, x2: 2, y2: 2 }],
    };
    const snapshot = JSON.stringify(redactions);
    buildRepeatPlan(header, LETTER, [1], sizes, redactions);
    expect(JSON.stringify(redactions)).toBe(snapshot);
  });
});

describe('applyRepeatPlan 一次批量加入', () => {
  const header = { x1: 0, y1: 732, x2: 612, y2: 792 };
  const sizes = [LETTER, A4, LETTER];

  it('应用页全部加入并生成新 id，跳过页不产生遮盖', () => {
    // 第 2 页是同尺寸 LETTER：放置完全相同的页眉遮盖，应被去重；第 1 页为 A4
    const sizesA4First = [A4, LETTER, LETTER];
    const redactions: RedactionMap = {
      2: [{ id: 'old', x1: 0, y1: 732, x2: 612, y2: 792 }],
    };
    const plan = buildRepeatPlan(header, LETTER, [1, 2, 3], sizesA4First, redactions);
    expect(plan.skippedPages).toEqual([2]);
    const { map, added } = applyRepeatPlan(redactions, plan);
    expect(added).toBe(2);
    expect(map[1]).toHaveLength(1);
    expect(map[2]).toHaveLength(1);
    expect(map[2][0].id).toBe('old');
    expect(map[3]).toHaveLength(1);
    // 不同尺寸页面（A4）上的坐标按比例映射
    const a4Box = map[1][0];
    expect(a4Box.x2).toBeCloseTo(595.28, 4);
    expect(a4Box.x2).not.toBe(612);
    expect(a4Box.id).toHaveLength(36); // uuid
  });

  it('应用前再次去重：预览后新增的相同遮盖不会重复加入', () => {
    const plan = buildRepeatPlan(header, LETTER, [1], sizes, {});
    const changedBase: RedactionMap = {
      1: [{ id: 'late', x1: 0, y1: 732, x2: 612, y2: 792 }],
    };
    const { map, added } = applyRepeatPlan(changedBase, plan);
    expect(added).toBe(0);
    expect(map[1]).toHaveLength(1);
    expect(map[1][0].id).toBe('late');
  });

  it('不修改输入 map（不可变更新，支撑撤销）', () => {
    const plan = buildRepeatPlan(header, LETTER, [1], sizes, {});
    const base: RedactionMap = { 2: [{ id: 'x', x1: 1, y1: 1, x2: 2, y2: 2 }] };
    const snapshot = JSON.stringify(base);
    applyRepeatPlan(base, plan);
    expect(JSON.stringify(base)).toBe(snapshot);
  });
});

describe('formatPageList', () => {
  it('8 页以内全部列出，超出折叠', () => {
    expect(formatPageList([1, 2, 3])).toBe('1、2、3');
    expect(formatPageList(Array.from({ length: 20 }, (_, i) => i + 1))).toContain('等 20 页');
  });
});
