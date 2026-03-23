# paper-pdf-flow

将论文 PDF 自动整理为“文献内容速览、按图梳理流程”的 Markdown 笔记。


## Codex用法
1. 在 GitHub 仓库页面点击 `Code -> Download ZIP` 下载压缩包并解压。
2. 将解压后的 `paper-pdf-flow` 整个目录放到 Codex skills 目录：
   - `C:\Users\<you>\.codex\skills\`
3. 如果解压后的目录名是 `paper-pdf-flow-main`，请改名为 `paper-pdf-flow`。
4. 确认关键文件存在：
   - `C:\Users\<you>\.codex\skills\paper-pdf-flow\SKILL.md`
   - `C:\Users\<you>\.codex\skills\paper-pdf-flow\scripts\pdf_to_flow_note.py`
5. 安装依赖：
   - `python -m pip install -r requirements.txt`
   - 如果系统使用 `python3`，改为 `python3 -m pip install -r requirements.txt`
6. 重启/刷新 Codex 会话。
7. 在对话里调用（把尖括号内路径和文件名字换成自己的）：
   ```text
   请调用技能 $paper-pdf-flow 处理论文 PDF，并输出最终版中文流程笔记。
   输入 PDF：<path\to\paper.pdf>
   输出文件夹：<path\to\output>
   输出文件名：你想要的文件名字.md（单文件输出，禁止副本）
   参数：--lang zh --mode final
   要求：严格输出固定5段结构（极简梳理/文献信息/要解决什么问题/按图流程/关键结论）。
   ```

## 插件用法
1. 在 GitHub 仓库页面点击 `Code -> Download ZIP` 下载压缩包并解压。
2. 打开 `chrome://extensions/`
3. 开启“开发者模式”并加载解压后 `paper-pdf-flow` 文件夹的 `extension/` 目录
3. 点击插件，进入 `API配置`
4. 填写地址、API 密钥、模型名字，点击“确认保存”
5. 返回主页面，选择 PDF，填写输出文件名，点击“开始生成”

## 输出固定结构
1. `# <pdf_stem> 极简梳理`
2. `## 文献信息`
3. `## 这篇论文要解决什么问题`
4. `## 按图看整篇流程（Fig.1~Fig.N）`
5. `## 关键结论（一句话）`


## skill适配不同 IDE
- 让你的agent对压缩包进行处理，自行配置和使用即可。


## 目录结构
- `SKILL.md`：技能触发说明与执行约束。
- `scripts/pdf_to_flow_note.py`：本地启发式生成脚本。
- `extension/`：Chrome 插件目录
- `backend/`：后端 MVP。
- `docs/`：架构设计与接口契约说明。
- `assets/minimal_flow_template_zh.md`：输出模板参考。
- `requirements.txt`：脚本依赖列表
