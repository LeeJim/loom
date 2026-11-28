import { useState, type FormEvent } from "react";
import { useOutletContext } from "react-router-dom";
import { Box, Cpu, Plus, Puzzle } from "lucide-react";
import { api, ApiError, base, type Capabilities, type Session, type Worker } from "./api";
import { Badge, Empty, Page, Panel, ReadState, Refresh, time, useResource } from "./ui";

export function Workers() {
  const session = useOutletContext<Session | undefined>();
  const { data: workers, error, loading, reload } = useResource<Worker[]>(session?.user ? "workers" : null, 15000);
  const { data: capabilities } = useResource<Capabilities>(session?.user ? "capabilities" : null);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  async function send(path: string, body: unknown, success: string) {
    setBusy(true); setNotice("");
    try { await api(path, { body }); setNotice(success); reload(); return true; }
    catch (error) {
      const hints: Record<string, string> = {
        model_catalog_unavailable: "暂时无法验证模型，请稍后重试。",
        model_not_available: "所选模型已不在网关清单中。",
        invalid_request: "请检查名称、Issue 执行配置及技能版本。",
      };
      setNotice(error instanceof ApiError && error.code && hints[error.code] || "Worker 操作失败。");
      return false;
    } finally { setBusy(false); }
  }
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    if (await send("workers", { name: fields.get("name"), issue_number: fields.get("issue") ? Number(fields.get("issue")) : null,
      model: fields.get("model") || null, skills: fields.getAll("skills").map(item => JSON.parse(String(item))) },
    "Worker 已创建，可在列表中启动。")) setCreating(false);
  }
  return <Page title="Worker" description="创建、启动、暂停或排空你拥有的 Worker。"
    action={session?.user && <button className="button primary" onClick={() => setCreating(value => !value)}>
      <Plus size={16} />{creating ? "关闭表单" : "创建 Worker"}</button>}>
    {!session?.user ? <Panel><Empty>{session?.enabled ? <a className="text-link" href={base + "oauth/login"}>使用 GitHub 登录</a>
      : session ? "创建和管理 Worker 需要配置 GitHub OAuth。" : "正在检查登录状态…"}</Empty></Panel> : <>
      {notice && <div className="notice" role="status">{notice}</div>}
      {creating && <Panel title="创建 Worker"><form className="worker-form" onSubmit={create}>
        <label>名称<input name="name" placeholder="例如：研发 Worker" maxLength={64} required /></label>
        <label>Issue 编号<input name="issue" type="number" min={1} placeholder="留空表示全部已配置任务" /></label>
        <label>模型<select name="model"><option value="">默认模型</option>{capabilities?.llm.items.map(model =>
          <option key={model.id} value={model.id}>{model.id}</option>)}</select></label>
        {capabilities?.skills.items.some(skill => skill.installed) && <label>技能<select name="skills" multiple>
          {capabilities.skills.items.filter(skill => skill.installed).map(({ id, version }) =>
            <option key={id + version} value={JSON.stringify({ id, version })}>{id}@{version}</option>)}</select></label>}
        <div className="form-actions"><button className="button primary" disabled={busy}>创建</button></div>
      </form></Panel>}
      <Panel title="我的 Worker" action={<Refresh busy={loading} action={reload} />}>
        <ReadState error={error} loading={loading && !workers} />
        {workers?.length === 0 && <Empty>你还没有 Worker。</Empty>}
        <ul className="rows">{workers?.map(worker => <li key={worker.id}>
          <div><strong>{worker.name}</strong><small>{worker.issue_number ? `Issue #${worker.issue_number}` : "全部已配置任务"}
            {" · "}{worker.model || "默认模型"}{worker.active_issue ? ` · 正在处理 #${worker.active_issue}` : ""}
            {worker.last_seen_at ? ` · ${time(worker.last_seen_at)}` : ""}</small>
            {worker.skills.length > 0 && <small>{worker.skills.map(skill => `${skill.id}@${skill.version}`).join("、")}</small>}
          </div>
          <div className="actions"><Badge value={worker.state} />
            {([
              ["running", "启动"], ["paused", "暂停"], ["draining", "排空"],
            ] as const).filter(([state]) => worker.state !== state).map(([state, label]) =>
              <button key={state} className="button small" disabled={busy} onClick={() =>
                send("workers/state", { id: worker.id, state }, "Worker 状态已更新。")}>{label}</button>)}</div>
        </li>)}</ul>
      </Panel>
    </>}
  </Page>;
}

export function CapabilitiesPage() {
  const { data, error, loading, reload } = useResource<Capabilities>("capabilities");
  return <Page title="能力" description="查看 AgentGateway 模型、MCP 工具和 SkillHub 技能。"
    action={<Refresh busy={loading} action={reload} />}>
    <ReadState error={error} loading={loading && !data} />
    {data && <div className="cap-grid">
      <Panel title="模型" action={<Badge value={data.llm.status} />}>
        <ul className="rows">{data.llm.items.map(item => <li key={item.id}><div className="icon-line"><Cpu size={16} />
          <span>{item.id}</span></div>{item.id === data.llm.configured_default && <Badge value="默认" />}</li>)}</ul>
        {!data.llm.items.length && <Empty>无可展示模型。默认配置为 {data.llm.configured_default}。</Empty>}
      </Panel>
      <Panel title="MCP" action={<Badge value={data.mcp.status} />}>
        <ul className="rows">{data.mcp.items.map(tool => <li key={tool.name}><div className="icon-line"><Puzzle size={16} />
          <div><strong>{tool.name}</strong><small>{tool.description}</small></div></div></li>)}</ul>
        {!data.mcp.items.length && <Empty>无可展示工具。</Empty>}
      </Panel>
      <Panel title="SkillHub" action={<Badge value={data.skills.status} />}>
        <ul className="rows">{data.skills.items.map(skill => <li key={skill.id + "@" + skill.version}><div className="icon-line"><Box size={16} />
          <div><strong>{skill.id}@{skill.version}</strong><small>{skill.description}</small></div></div>
          <Badge value={skill.installed ? "已安装" : "未安装"} /></li>)}</ul>
        {!data.skills.items.length && <Empty>无可展示技能。</Empty>}
      </Panel>
    </div>}
  </Page>;
}
