import { useMemo } from 'react';
import type { RepeatPlan, RepeatPlanItem, RegionRect } from '../pdf/repeatRegion';
import { formatPageList } from '../pdf/repeatRegion';

interface Props {
  /** 拾取到的源区域（当前页 PDF 坐标）；null 表示尚未框选 */
  region: RegionRect | null;
  /** 源区域所在页码及其未旋转尺寸（点） */
  sourcePage: number;
  sourceWidth: number;
  sourceHeight: number;
  numPages: number;
  rangeInput: string;
  onRangeChange(v: string): void;
  onPreview(): void;
  /** 页码输入解析错误（与计划无关） */
  rangeError: string | null;
  plan: RepeatPlan | null;
  currentPage: number;
  onJump(page: number): void;
  onApply(): void;
  /** 取消 / 关闭：丢弃区域与预览，不改动现有遮盖 */
  onClose(): void;
}

const trimNum = (n: number) => `${Math.round(n * 100) / 100}`;

/**
 * 跨页重复区域面板：
 * ① 在当前页框选页眉 / 页脚等区域（画布上完成，仅拾取不生成遮盖）；
 * ② 输入页码范围（如 1-3,5）后预览各目标页将生成的遮盖框；
 * ③ 面板分别列出“应用页”和“跳过页”（重复 / 夹取后退化）；
 * ④ 确认后整批一次加入（仅一条撤销记录）；取消 / 关闭不改动任何现有遮盖。
 */
export function RepeatPanel(props: Props) {
  const { region, plan } = props;

  const skippedDup = useMemo(
    () => (plan ? plan.items.filter((i) => i.skipReason === 'duplicate') : []),
    [plan],
  );
  const skippedDegenerate = useMemo(
    () => (plan ? plan.items.filter((i) => i.skipReason === 'degenerate') : []),
    [plan],
  );
  const clampedApplied = useMemo(
    () => (plan ? plan.items.filter((i) => i.applied && i.region.clamped) : []),
    [plan],
  );

  return (
    <aside className="find-panel repeat-panel">
      <div className="find-head">
        <span className="find-title">跨页重复区域</span>
        <button className="find-close" onClick={props.onClose} title="关闭面板" aria-label="关闭">
          ×
        </button>
      </div>

      <div className="find-hint">
        在当前页框选页眉 / 页脚等固定区域，再指定页码范围；区域按页面宽高比例映射到不同尺寸页面，越界部分自动夹取。全程纯本地，预览不会改动现有遮盖。
      </div>

      <div className="repeat-section">
        <div className="repeat-label">① 源区域（在第 {props.sourcePage} 页框选）</div>
        {region ? (
          <div className="find-status ok repeat-region-info">
            已框选：x {trimNum(region.x1)}–{trimNum(region.x2)}，y {trimNum(region.y1)}–
            {trimNum(region.y2)}（{trimNum(props.sourceWidth)} × {trimNum(props.sourceHeight)} 点）。
            可在画布上重新框选以替换。
          </div>
        ) : (
          <div className="find-status warn">尚未框选区域：请在中间页面上按住鼠标拖出一个矩形。</div>
        )}
      </div>

      <form
        className="find-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (region) props.onPreview();
        }}
      >
        <div className="repeat-label">② 目标页码范围（共 {props.numPages} 页）</div>
        <input
          className="find-input repeat-range-input"
          value={props.rangeInput}
          onChange={(e) => props.onRangeChange(e.target.value)}
          placeholder="如 1-3,5"
          spellCheck={false}
        />
        <div className="find-actions">
          <button type="submit" className="primary" disabled={!region}>
            预览
          </button>
        </div>
        <div className="find-hint">支持 1-3、1-3,5、中文逗号 / 顿号；重复页码自动去重。</div>
      </form>

      {props.rangeError && <div className="find-status warn">{props.rangeError}</div>}

      {plan && (
        <div className="repeat-result">
          {plan.appliedPages.length > 0 ? (
            <div className="find-status ok">
              将在 {plan.appliedPages.length} 页加入遮盖：
              第 {formatPageList(plan.appliedPages)} 页
            </div>
          ) : (
            <div className="find-status warn">没有可新增遮盖的页面（目标页全部重复或区域越界）。</div>
          )}

          {clampedApplied.length > 0 && (
            <div className="find-status dim">
              第 {formatPageList(clampedApplied.map((i) => i.page))} 页的区域超出边界，已夹取到页面内。
            </div>
          )}

          {skippedDup.length > 0 && (
            <div className="find-status dim">
              跳过 {skippedDup.length} 页（与已有遮盖在 0.01 点容差内相同）：
              第 {formatPageList(skippedDup.map((i) => i.page))} 页
            </div>
          )}

          {skippedDegenerate.length > 0 && (
            <div className="find-status dim">
              跳过 {skippedDegenerate.length} 页（区域夹取后为空，完全落在页面外）：
              第 {formatPageList(skippedDegenerate.map((i) => i.page))} 页
            </div>
          )}

          <div className="repeat-legend">
            <span>
              <i className="legend-box legend-applied" /> 将加入
            </span>
            <span>
              <i className="legend-box legend-dup" /> 重复跳过
            </span>
          </div>

          <ul className="find-hit-list repeat-page-list">
            {plan.items.map((item) => (
              <li key={item.page}>
                <button
                  type="button"
                  className={`find-page-link repeat-page-link${item.page === props.currentPage ? ' current' : ''}`}
                  onClick={() => props.onJump(item.page)}
                >
                  第 {item.page} 页
                </button>
                <RepeatItemLabel item={item} />
              </li>
            ))}
          </ul>

          <div className="repeat-actions">
            <button onClick={props.onClose}>取消</button>
            <button
              className="primary"
              disabled={plan.appliedPages.length === 0}
              onClick={props.onApply}
              title="把全部应用页的遮盖框一次加入，整批只产生一条撤销记录"
            >
              确认加入（{plan.appliedPages.length} 页）
            </button>
          </div>
        </div>
      )}
    </aside>
  );
}

function RepeatItemLabel({ item }: { item: RepeatPlanItem }) {
  if (item.applied) {
    return (
      <span className="dim">
        将加入{item.region.clamped ? '（已夹取）' : ''}
      </span>
    );
  }
  if (item.skipReason === 'degenerate') {
    return <span className="dim">跳过：夹取后为空</span>;
  }
  return <span className="dim">跳过：重复</span>;
}
