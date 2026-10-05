# ResearchPage Visual Implementation Spec

Status: FROZEN FOR COMPETITION IMPLEMENTATION
Scope: Frontend visual implementation only

本文件补充 `ResearchPage_Product_Redesign.md`。

产品交互、Research 语义、Ask / Research / Edit、
Proposal、Revision 等业务规则以前述设计稿为准。

本文件只回答：

ResearchPage 应该如何被实现成一个
精致、统一、稳定的 desktop-grade research tool。

---

## 1. Visual Goal

ResearchPage 不应看起来像：

- 后台管理系统
- CRUD Dashboard
- ChatGPT clone
- VS Code / IDE
- 普通学术网站
- 卡片堆叠 SaaS
- 大面积 AI 紫色渐变产品

目标：

> modern research tool
> + editorial artifact
> + quiet premium software

三个关键词：

**精确 / 克制 / 有编辑感**

产品 UI 应现代、轻盈、精致。

Research Artifact 应强调：

- typography
- information hierarchy
- reading rhythm
- evidence readability

高级感来自：

- spacing
- typography
- hierarchy
- surface
- state design
- motion restraint

而不是：

- 大阴影
- 大渐变
- glass everywhere
- 发光边框
- emoji
- 大圆角 Card 墙

---

## 2. Technology

Frontend stack:

- React 19
- Mantine 9
- Lucide icons
- existing esbuild pipeline
- custom ResearchPage CSS / CSS variables

Mantine 负责：

- Button
- ActionIcon
- TextInput
- Textarea
- PasswordInput
- Select
- SegmentedControl
- Tabs
- Menu
- Popover
- Tooltip
- Modal
- Drawer
- ScrollArea
- Notification
- Skeleton
- loading / focus / keyboard behavior

不要重复手写这些交互 primitive。

ResearchPage 自己实现：

- AppShell
- StartView
- ResearchBrief
- ResearchMatrix
- MatrixCell
- ReportStudio
- DocumentCanvas
- ContextDock
- AssistantComposer
- ActionPreview
- EvidenceInspector
- ProposalView
- SourceWorkspace
- TemplateGallery
- ThemePreview

禁止同时引入：

- Fluent UI
- shadcn/ui
- Radix Themes
- Ant Design
- Material UI
- 第二套完整 design system

如 Mantine 内部依赖其它 primitive，
不视为第二套设计系统。

---

## 3. Critical Boundary

Mantine 用于：

**Application UI**

Mantine 不用于：

**Research Artifact Renderer**

Report / HTML / PDF 必须使用独立的 semantic renderer
和自定义 document CSS。

禁止把 Mantine Card / Badge / Table
直接打印成最终 PDF。

结构：

Application UI
    ↓
Research Project / Actions

Structured Report
    ↓
Document Renderer
    ↓
Editorial / Swiss Theme
    ↓
HTML / PDF

两者共享：

- design tokens where appropriate
- brand accent
- semantic status colors

但不共享完整组件体系。

---

## 4. Application Color System

### Base

App background:
`#F5F6F4`

Surface:
`#FFFFFF`

Secondary surface:
`#FAFBF9`

Floating surface:
`rgba(255,255,255,0.94)`

Primary text:
`#1F2C33`

Secondary text:
`#657078`

Muted text:
`#8B9499`

Hairline:
`rgba(31,44,51,0.09)`

Strong border:
`rgba(31,44,51,0.16)`

### Brand

Primary:
`#244B60`

Primary hover:
`#1C3D4F`

Primary subtle:
`#EAF1F4`

Selection:
`#E9F1F6`

Focus:
`#3D6F89`

### Semantic

Verified:
`#32705A`

Verified subtle:
`#EAF4EF`

Limited:
`#94651C`

Limited subtle:
`#FFF4DF`

Conflict:
`#74569A`

Conflict subtle:
`#F3EDFA`

Danger:
`#AD4742`

Danger subtle:
`#FBEDEA`

不要只用颜色表达状态。
所有状态必须同时有文字。

---

## 5. Surface Model

只允许三种 Application surface：

### Base

页面背景。

### Surface

表单、项目项、matrix area。

通常：

- 白色或接近白色
- hairline border
- 无阴影或极弱阴影

### Floating

仅用于：

- Context Dock
- Popover
- Modal
- Menu
- Command surface

允许：

- subtle transparency
- backdrop blur 10–16 px
- soft shadow

禁止给所有 Card 加 floating shadow。

---

## 6. Radius

统一：

- control: 8px
- compact surface: 10px
- floating panel: 14px
- project tile: 12px
- Document Canvas: 3–4px

禁止：

大量 16–24px rounded card。

报告内部 Swiss Theme
允许 0–2px。

---

## 7. Shadow

普通 Surface：

最多：

`0 1px 2px rgba(20,32,38,.035)`

Floating：

`0 14px 36px rgba(20,32,38,.10)`

Document Canvas：

`0 2px 10px rgba(20,32,38,.045)`

禁止：

- heavy shadow
- multiple glowing shadows
- colored shadow

---

## 8. Typography

### Application UI

优先：

- Inter / Geist
- Noto Sans SC
- system-ui fallback

层级：

Metadata:
11–12px

Secondary:
13px

UI body:
14px / 21–22px

Important control:
14–15px

Section title:
18–20px

Page title:
26–30px

禁止整个 UI 都使用 14px + font-weight 400。

### Research Artifact

Editorial:

- Noto Serif SC / Source Han Serif for major headings / reading body when appropriate
- Sans-serif metadata

Swiss:

- Noto Sans SC
- Inter / Geist
- optional ui-monospace for numeric metadata

Document Typography
由 Report Theme 控制，
不继承 Mantine 默认 typography。

---

## 9. Spacing

基础 scale：

4 / 8 / 12 / 16 / 24 / 32 / 48 / 64

规则：

- control internal spacing: 8–12
- related fields: 12–16
- component groups: 24
- page sections: 32–48
- major page rhythm: 48–64

避免：

每一个内容都包 Card
再统一 padding 16。

应该通过空白建立层级。

---

## 10. Global Shell

顶部 Global Bar：

高度约 52–56px。

只包含：

- ResearchPage identity
- current project
- global project switch
- settings
- lightweight runtime status

Project Navigation：

约 40–44px。

仅：

- Research
- Report
- Sources
- Research Brief entry where appropriate
- Assistant action

不要把：

History / Settings / Evidence / Claims / Diagrams

全部做一级导航。

---

## 11. Start / Library

视觉目标：

**calm starting point**

第一视觉焦点：

Research Composer。

不要：

三栏
Dashboard metrics
feature cards
Evidence status

Research Composer 应：

- 比普通 input 明显更大
- 具有轻量 floating feeling
- 支持 Sources 入口
- 显示少量 suggestion
- primary action 清晰

Recent Projects：

优先 project row / document tile。

不要全部做独立大白 Card。

每个项目只展示：

- title
- type
- state
- last updated
- one useful status

---

## 12. Research Brief

不能做：

“左 Chat / 右企业表单”的死板布局。

目标：

**conversation shapes structure**

Assistant：
轻量、自然。

Brief：
始终是视觉主对象。

当 Assistant 更新一个字段：

- field subtle highlight 400–600ms
- 显示 AI suggested / updated state
- 用户可以直接修改
- 可撤销

尽量使用：

- segmented controls
- editable chips
- inline select
- compact field groups

减少：

大量 full-width rectangular inputs。

---

## 13. Research Matrix

Evidence Matrix 是 Research View 的视觉中心。

禁止实现成普通 Excel。

弱化纵向 border。

每格应包含：

Status
Short judgment
Evidence summary

例如：

Verified
机制步骤已定位
2 evidence · 1 primary

Limited
仅作者自报
2 evidence

Need review
基线定义过宽
1 evidence

Cell 默认平面化。

Hover：

- subtle elevated background
- border becomes visible

Selected：

- accent outline / inset line
- background subtle accent
- target remains obvious when Dock opens

Matrix 行标题必须明确：

研究问题是什么，
而不是只有一个名词。

---

## 14. Report Studio

这是产品最重要界面。

默认状态：

**document first**

不得常驻：

- History
- Sources list
- Task Card
- Matrix
- Run log

中央 Document Canvas：

max-width ~920px。

正文 reading width：

约 680–720px。

图表、Comparison 可以突破 reading width。

顶部 Studio Toolbar：

- TOC
- Read / Verify
- revision
- theme
- assistant
- publish

保持克制。

---

## 15. Object Selection

用户选中：

- Section
- Claim
- Comparison
- Diagram

才出现对象操作。

统一动作：

- Inspect
- Research
- Edit
- More

不要每种对象出现十个按钮。

选中状态：

- subtle background
- left or top accent
- small semantic label

禁止：

大块蓝框把整个 Section 框住。

---

## 16. Context Dock

一个统一 Dock。

承载：

- Evidence Inspector
- Assistant
- Source details
- Proposal details

宽度约：

352–384px。

1440+ 可 push，
较窄窗口 overlay。

Dock 应有 floating quality：

- soft surface
- subtle blur
- thin border
- restrained shadow

不是普通右侧白色 Sidebar。

---

## 17. Assistant

Assistant 不是聊天软件。

禁止：

大量左右聊天气泡。

它是：

**command surface + research action log**

Composer：

Target
Intent
Prompt

Target 示例：

Section · 成本与比较条件

Intent：

Auto / Ask / Research / Edit

执行结果优先呈现为：

Action Cards。

例如：

Research completed

+2 evidence
1 conflicting condition
Report unchanged

[Inspect]
[Create revision]

而不是：

“助手：好的，我已经帮你……”

Ask 型自然问答
才允许普通 conversational response。

---

## 18. Proposal

Proposal 必须明显不同于：

normal report content。

应该展示：

- current
- proposed
- changed claims
- evidence change
- scope

但首版不需要 Git-style character diff。

允许：

Current / Proposed toggle

或：

Current above
Proposed below

主动作：

Accept revision

次动作：

Discard

Proposal surface
可以使用轻微 accent，
不能使用大面积成功绿。

---

## 19. Source Workspace

不要像 Admin Data Table。

推荐：

clean editorial table/list hybrid。

弱化 cell borders。

Title 列承担主要信息：

Title
Author / origin
Year / identifier

其余：

Role
Read scope
Parser
Evidence count
Required

状态使用：

text + subtle badge

不是五颜六色 badge wall。

Row hover / selected
打开 Context Dock。

---

## 20. Template Gallery

Gallery 必须是视觉体验。

Blueprint 与 Theme 分离。

Theme Preview：

必须使用同一份真实 report content。

Preview 卡：

- 较大
- artifact-like
- 高质量 thumbnail
- hover subtle lift
- selected clear

不能用：

select dropdown。

切 Theme：

只改变 presentation。

UI 应明确：

content unchanged
evidence unchanged

---

## 21. Document Themes

P0:

### Editorial

感觉：

research journal
editorial note
warm paper

特点：

- warm paper
- serif emphasis
- generous whitespace
- thin rules
- muted ink blue
- reading rhythm
- almost no cards

### Swiss

感觉：

technical analytical publication

特点：

- white background
- sans-serif
- numbered hierarchy
- strong grid
- tighter comparison
- clean blue accent
- structured tables

两套必须即使转成灰度，
也能通过：

typography
grid
spacing

看出明显区别。

---

## 22. Motion

只允许高 ROI motion。

Dock open:
~160ms

Object selection:
~100ms

Matrix real update:
~400–500ms subtle flash

Proposal:
~150ms

Theme preview:
~120ms crossfade

禁止：

- typing animation
- particles
- breathing glow
- fake progress percentage
- animated gradient background
- page transition spectacle

支持 prefers-reduced-motion。

---

## 23. Responsive

只做：

1366×768
1440×900
1920×1080

Desktop only。

1366：

Dock overlay。

1440：

视实际宽度 push / overlay。

1920：

Document 不随窗口无限变宽。

保持最大阅读宽度。

---

## 24. Prohibited Patterns

Coding Agent 不得使用：

- random gradients
- purple AI branding
- emoji as main icons
- every block as a Card
- huge rounded corners
- heavy shadows
- dashboard KPI tiles
- glassmorphism everywhere
- multiple component libraries
- meaningless skeleton screens
- fake progress
- raw JSON visible in normal UX
- developer terminology in user-facing UI
- permanent 3-column layout
- permanent chat panel

---

## 25. Implementation Rule

视觉实现优先级：

1. hierarchy
2. spacing
3. typography
4. state clarity
5. interaction
6. surface
7. motion
8. decoration

任何情况下：

Decoration 不得先于 hierarchy。

如果一个页面删掉：

shadow
color
motion

以后就失去可读层级，

说明设计失败。

---

## 26. Acceptance

最终必须截图检查：

1366×768
1440×900
1920×1080

至少：

Start
Brief
Research
Studio
Studio + Dock
Sources
Gallery
Settings

检查：

- 第一视觉焦点是否唯一
- 是否像同一个产品
- 是否有无意义 Card wall
- Assistant 是否抢主体
- Matrix 是否像 Excel
- Sources 是否像 Admin
- Report 是否真的像 publication
- Editorial / Swiss 是否真正不同
- 1366 是否可正常操作