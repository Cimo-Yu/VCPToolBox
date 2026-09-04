[2026-09-04 12:30] - Nova

# VCPdesktop 三种 Shadow DOM 隔离与跨影样式注入（源码实证）

## 核心概念
VCPdesktop 内共存三种 Shadow DOM 用法，隔离级别与可干预程度各不相同。任何"全局生效"的样式改动都必须逐类处理，因为**继承属性不足以穿透 shadow 边界**——影内 UA 样式表会就地覆盖继承值。

## 三类宿主

### ① 挂件内容区 — `mode:'open'`
`core/widgetManager.js:74` `contentWrapper.attachShadow({ mode:'open' })`。
注入的基线样式（`:77`）：
```css
:host { display:block; width:100%; height:100%; overflow:auto; }
* { box-sizing: border-box; }
::-webkit-scrollbar { width:4px; }
::-webkit-scrollbar-track { background:transparent; }
::-webkit-scrollbar-thumb { background:rgba(128,128,128,0.3); border-radius:2px; }
```
结构：shadowRoot → [style, ...(提升的挂件 style), div.widget-inner-content]。
`processInlineStyles()` 把挂件 HTML 内的 `<style>` 提升到 shadowRoot 根级（insertBefore 到 contentContainer 之前）并删除原标签。
open 模式故外部可 `el.shadowRoot` 访问，可运行期追加 style 节点。

### ② 图标富渲染 — `mode:'closed'`（五处）
`ui/dock.js:219`（Dock 图标）、`:531`（抽屉卡）、`:1027`（桌面图标）、`:1695`（图标替换）、`ui/iconPicker.js:228`（选择器预览）。
五处共享**同一个模板字符串**：
```html
<style>:host{display:block;width:100%;height:100%;overflow:hidden;}
.vcp-html-icon-wrap{width:100%;height:100%;display:flex;align-items:center;
justify-content:center;overflow:hidden;transform-origin:center center;}</style>
<div class="vcp-html-icon-wrap">${htmlIcon}</div>
```
closed 模式 → 外部拿不到 shadowRoot，**唯一干预手段是改这五处模板串**。

### ③ 其他模块（非 desktop）
`ScriptoriumModules/scriptorium-render-primitives.js:21`、`scriptorium-deck-renderer.js:209`、`modules/text-viewer.js:1768` 均用 open 模式，与桌面无关但同属仓库内 shadow 用法。

## 关键机制：继承属性为何不穿透
`cursor`、`color`、`font` 等是 CSS 继承属性，理论上继承值可跨 shadow 边界传入。但**影内的 UA 样式表仍会对匹配元素直接赋值**（如 `a:any-link { cursor:pointer }`、`input { cursor:text }`），该声明作用在影内元素自身，优先于从宿主继承来的值。

结论：宿主侧写 `* { cursor:none !important }` 无法压住影内的 `a`/`input`/`button`。必须在**每个 shadowRoot 内部**再写一份。

## 反向机制：自定义属性确实穿透
CSS 自定义属性（`--foo`）是继承属性且**无 UA 样式表参与**，故从宿主继承的值在影内保持有效，可用 `getComputedStyle(el).getPropertyValue('--foo')` 读到。

配合 shadow 的事件重定向，得到一个通吃两种隔离级别的模式：
- **open shadow**：`e.composedPath()[0]` 拿到影内真实目标元素，其 `--foo` 从宿主链继承。
- **closed shadow**：事件被重定向到宿主，`composedPath()` 也在宿主处截断，读到的正是宿主自身的 `--foo`。

即：**事件重定向与属性继承在 shadow 边界上方向相反**，二者叠加使同一段探针代码对两种模式都返回可用值（closed 的语义分辨率退化到宿主粒度，这通常正是想要的）。

**必须用 `composedPath()[0]` 而非 `e.target`**：对 open shadow，`e.target` 已被重定向到宿主，语义分辨率会坍缩到挂件整体粒度。

## 已知盲区
挂件内可嵌 `<iframe>`（`desktop.html` CSP 允许 `frame-src 'self' file: data:`）。跨文档无法注入样式，该区域不受宿主样式协议控制。
原生表面（`<select>` 弹层、系统文件对话框）同样不可干预。

## 一般化判据
1. **"全局样式"在存在 Shadow DOM 的应用里是不存在的**。任何声称全局的改动都需先枚举 shadow 宿主，按 open/closed 分类处置，closed 只能改创建处的模板串。
2. **要跨影传递意图，用自定义属性而非标准属性**——前者无 UA 干扰，后者会被就地覆盖。

## 信源出处
D:\vcp\VCPChat 源码直读，2026-09-04。
