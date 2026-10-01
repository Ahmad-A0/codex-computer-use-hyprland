// Like macOS, windows that a background-launched app opens later (dialogs, new
// windows, X11 menus) appear with the app instead of on the user's workspace,
// without taking focus. Hyprland's exec rule only places the first window, so the
// static rules of every later window are amended before it maps: a window with a
// mapped transient parent follows the parent's current workspace; any other
// window follows the app's other windows, else the launch workspace.
// Only processes the provider launched (registered by the launcher before it
// execs the app, or marked in their environment) and their descendants are
// affected, plus windows parented to such a process's window.
namespace Placement {
inline constexpr const char* ENV_NAME="CODEX_HYPRLAND_PLACEMENT";
struct App {pid_t pid;unsigned long long start;std::string workspace;};
inline std::vector<App> apps;
inline CFunctionHook* hook=nullptr;
inline uint64_t placed=0;  // diagnostic: windows placed so far (status)
inline std::vector<PHLWINDOWREF> mapping;  // placed windows whose map has not finished
inline CHyprSignalListener mapped;
// /proc/<pid>/stat: parent PID and start time, or {0,0} once the process is gone.
inline std::pair<pid_t,unsigned long long> stat(pid_t pid){
    std::ifstream file("/proc/"+std::to_string(pid)+"/stat");std::string line;
    if(!std::getline(file,line))return {0,0};
    auto close=line.rfind(')');if(close==std::string::npos)return {0,0};
    std::istringstream fields(line.substr(close+2));std::string value;pid_t parent=0;unsigned long long start=0;
    for(int i=3;i<=22 && fields>>value;++i){if(i==4)parent=std::strtol(value.c_str(),nullptr,10);if(i==22)start=std::strtoull(value.c_str(),nullptr,10);}
    return {parent,start};
}
inline bool validWorkspace(const std::string& w){return w.size()<=255 && std::ranges::none_of(w,[](char c){return c==';'||c=='['||c==']'||c=='\n'||c=='\0';});}
inline App* find(pid_t pid){
    if(pid<=1)return nullptr;
    for(auto& app:apps)if(app.pid==pid)return stat(pid).second==app.start?&app:nullptr;
    return nullptr;
}
inline void track(pid_t pid,unsigned long long start,const std::string& workspace){
    std::erase_if(apps,[&](const App& a){return a.pid==pid || stat(a.pid).second!=a.start;});
    if(apps.size()>=256)apps.erase(apps.begin());
    apps.push_back({pid,start,workspace});
}
// The registered app this process belongs to (itself or an ancestor), else an
// environment marker the launcher left; descendants are registered on first sight.
inline App* owner(PHLWINDOW window){
    auto pid=window->getPID();if(pid<=1)return nullptr;
    if(auto* app=find(pid))return app;
    auto self=stat(pid);if(!self.second)return nullptr;
    auto parent=self.first;
    for(int depth=0;depth<32 && parent>1;++depth){
        if(auto* app=find(parent)){auto workspace=app->workspace;track(pid,self.second,workspace);return find(pid);}
        parent=stat(parent).first;
    }
    auto env=window->getEnv();auto marker=env.find(ENV_NAME);
    if(marker==env.end() || !validWorkspace(marker->second))return nullptr;
    track(pid,self.second,marker->second=="current"?"":marker->second);
    return find(pid);
}
inline std::string spec(const PHLWORKSPACE& w){
    if(w->m_isSpecialWorkspace)return w->m_name;
    if(w->m_id>0)return std::to_string(w->m_id);
    return "name:"+w->m_name;
}
inline void place(Desktop::Rule::CWindowRuleApplicator* rules){
    PHLWINDOW window;
    for(auto& w:Desktop::windowState()->windows())if(w->m_ruleApplicator.get()==rules){window=w;break;}
    if(!window || !window->m_isMapped || !window->m_firstMap)return;
    auto parent=window->parent();
    auto* app=owner(window);
    App* parentApp=parent?owner(parent):nullptr;
    if(!app && !parentApp)return;
    auto pid=window->getPID();
    PHLWORKSPACE target;
    if(parent)target=parent->m_workspace;
    else for(auto& w:Desktop::windowState()->windows()|std::views::reverse)
        if(w!=window && w->m_isMapped && !w->isHidden() && w->getPID()==pid && !w->isX11OverrideRedirect() && w->m_workspace){target=w->m_workspace;break;}
    if(target && target->inert())target.reset();
    // The user is working in this app here: it opens new windows normally.
    auto focused=Desktop::focusState()->window();
    if(focused && (focused->getPID()==pid || (parent && focused->getPID()==parent->getPID())) && (!target || focused->m_workspace==target))return;
    auto workspace=target?spec(target):app?app->workspace:parentApp->workspace;
    if(!workspace.empty() && validWorkspace(workspace))rules->static_.workspace=workspace+" silent";
    rules->static_.noInitialFocus=true;
    rules->focusOnActivate().set(false,Desktop::Types::PRIORITY_WINDOW_RULE);
    std::erase_if(mapping,[](const PHLWINDOWREF& w){return !w;});
    if(mapping.size()<256 && std::ranges::none_of(mapping,[&](const PHLWINDOWREF& w){return w.lock()==window;}))mapping.emplace_back(window);
    ++placed;
}
// Hyprland floats an X11 window at the position it asked for, converted from X
// coordinates without regard to its workspace: a window at the X origin lands on
// whichever monitor holds that X position, though its workspace is on another.
// It is then invisible there, and its toplevel capture never completes, because
// Hyprland copies a window only on commits of its own monitor while overlapping it.
// Once mapped, bring such a window onto its workspace's monitor, centred on its
// parent when that is there, else in the work area, as Hyprland places others.
inline void settle(PHLWINDOW window){
    auto it=std::ranges::find_if(mapping,[&](const PHLWINDOWREF& w){return w.lock()==window;});
    if(it==mapping.end())return;
    mapping.erase(it);
    if(!window->m_isMapped || !window->m_isFloating || window->isX11OverrideRedirect() || !window->m_workspace)return;
    auto monitor=window->m_workspace->m_monitor.lock();if(!monitor)return;
    auto size=window->size(Desktop::View::IGeometric::GEOMETRIC_GOAL);
    CBox box{window->position(Desktop::View::IGeometric::GEOMETRIC_GOAL),size};
    if(!box.intersection(monitor->logicalBox()).empty())return;
    auto target=window->layoutTarget();if(!target)return;
    auto center=monitor->logicalBox().middle();
    if(auto space=target->space())center=space->workArea(true).middle();
    if(auto parent=window->parent(); parent && parent->m_workspace==window->m_workspace){
        CBox parentBox{parent->position(Desktop::View::IGeometric::GEOMETRIC_GOAL),parent->size(Desktop::View::IGeometric::GEOMETRIC_GOAL)};
        if(!parentBox.intersection(monitor->logicalBox()).empty())center=parentBox.middle();
    }
    target->setPositionGlobal(CBox{center-size/2.F,size});
}
inline bool readStaticRules(Desktop::Rule::CWindowRuleApplicator* rules,bool preRead){
    auto result=reinterpret_cast<bool(*)(Desktop::Rule::CWindowRuleApplicator*,bool)>(hook->m_original)(rules,preRead);
    // Only the map-time read decides the workspace; the commit-time pre-read does not.
    if(!preRead)try{place(rules);}catch(const std::exception&){}
    return result;
}
inline std::string launched(json_object* j){
    auto pid=static_cast<pid_t>(num(j,"pid"));auto workspace=str(j,"workspace");
    require(pid>1 && validWorkspace(workspace),"Invalid launch placement");
    auto self=stat(pid);require(self.second,"Launched process is gone");
    track(pid,self.second,workspace);
    return R"({"ok":true})";
}
inline void setup(HANDLE plugin){
    auto matches=HyprlandAPI::findFunctionsByName(plugin,"CWindowRuleApplicator15readStaticRules");
    require(matches.size()==1,"Cannot locate window rule entry point");
    hook=HyprlandAPI::createFunctionHook(plugin,matches[0].address,reinterpret_cast<void*>(readStaticRules));
    require(hook && hook->hook(),"Cannot install launch placement");
    mapped=Event::bus()->m_events.window.openLate.listen([](PHLWINDOW window){try{settle(window);}catch(const std::exception&){}});
}
inline void clear(){mapped.reset();if(hook){hook->unhook();hook=nullptr;}apps.clear();mapping.clear();}
}
