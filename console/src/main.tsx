import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Link, NavLink, Outlet, Route, Routes, useLocation } from "react-router-dom";
import { Activity, Blocks, ChevronRight, CircleCheck, ClipboardList, Github, LayoutDashboard, LogOut, Workflow } from "lucide-react";
import { base, type Session } from "./api";
import { useResource } from "./ui";
import { Overview, Tasks } from "./tasks";
import { CapabilitiesPage, Workers } from "./operations";
import { Audit, ExecutionDetail, Executions } from "./history";
import "./style.css";

const navigation = [
  { to: "/", label: "总览", icon: LayoutDashboard },
  { to: "/tasks", label: "任务", icon: ClipboardList },
  { to: "/executions", label: "执行记录", icon: Activity },
  { to: "/workers", label: "Worker", icon: Workflow },
  { to: "/capabilities", label: "能力", icon: Blocks },
  { to: "/audit", label: "审计", icon: CircleCheck },
];

function Layout() {
  const { data: session } = useResource<Session>("session");
  const location = useLocation();
  const current = navigation.find(item => item.to === location.pathname ||
    (item.to !== "/" && location.pathname.startsWith(item.to + "/")));
  async function logout() {
    const response = await fetch(base + "oauth/logout", { method: "POST" });
    if (response.ok) locationReload();
  }
  return <div className="shell">
    <aside className="sidebar">
      <Link to="/" className="brand"><div className="brand-mark"><Workflow size={18} /></div>
        <span>Loom<small>工作流控制台</small></span></Link>
      <nav aria-label="控制台菜单">
        {navigation.map(({ to, label, icon: Icon }) => <NavLink key={to} to={to} end={to === "/"}>
          <Icon size={17} /><span>{label}</span>
        </NavLink>)}
      </nav>
    </aside>
    <div className="workspace">
      <div className="topbar">
        <div className="breadcrumb"><span>控制台</span><ChevronRight size={14} />{current?.label || "页面"}</div>
        {session?.user ? <button className="button" onClick={logout}><LogOut size={15} />{session.user.login}</button>
          : session?.enabled && <a className="button" href={base + "oauth/login"}><Github size={16} />GitHub 登录</a>}
      </div>
      <main className="content"><Outlet context={session} /></main>
    </div>
  </div>;
}

function locationReload() { window.location.assign(base); }

createRoot(document.getElementById("root")!).render(<StrictMode><BrowserRouter basename={base.replace(/\/$/, "")}>
  <Routes>
    <Route element={<Layout />}>
      <Route index element={<Overview />} />
      <Route path="tasks" element={<Tasks />} />
      <Route path="executions" element={<Executions />} />
      <Route path="executions/:id" element={<ExecutionDetail />} />
      <Route path="workers" element={<Workers />} />
      <Route path="capabilities" element={<CapabilitiesPage />} />
      <Route path="audit" element={<Audit />} />
      <Route path="*" element={<div className="notice">页面不存在。 <Link to="/">返回总览</Link></div>} />
    </Route>
  </Routes>
</BrowserRouter></StrictMode>);
