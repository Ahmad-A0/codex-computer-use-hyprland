// Hyprland API differences between releases and its development branch, which
// still reports the last release's version, so they are told apart by headers.
// Main splits windows into backends (desktop/view/window/), replaces the
// workspace class (workspace/), passes an explicit render context and moves
// hyprctl commands to ipc/s1.
namespace Compat {
#if CODEX_HYPRLAND_WINDOW_BACKENDS
inline pid_t pid(const PHLWINDOW& w){return w->backend().pid();}
inline bool mapped(const PHLWINDOW& w){return w->mapped();}
// Set for the duration of every mapWindow(), as m_firstMap is on releases
// (src/desktop/view/window/Window.cpp, CWindow::mapWindow).
inline bool firstMap(const PHLWINDOW& w){return bool(w->m_state & Desktop::View::WINDOW_STATE_FIRST_MAP);}
inline PHLWINDOW parent(const PHLWINDOW& w){return w->backend().parent();}
inline bool x11(const PHLWINDOW& w){return w->backend().isX11();}
inline bool overrideRedirect(const PHLWINDOW& w){return w->backend().traits().overrideRedirect;}
inline bool floating(const PHLWINDOW& w){return w->isFloating();}
inline const SP<Desktop::View::CPopup>& popupHead(const PHLWINDOW& w){return w->popupHead();}
inline bool mapped(const SP<Desktop::View::CPopup>& p){return p->mapped();}
// An X11 window's backend client ID is its X window ID
// (src/desktop/view/window/X11Backend.cpp: m_clientID.id=surface->m_xID).
inline std::optional<uint32_t> xid(const PHLWINDOW& w){if(!x11(w))return std::nullopt;return uint32_t(w->backend().clientID().id);}
#else
inline pid_t pid(const PHLWINDOW& w){return w->getPID();}
inline bool mapped(const PHLWINDOW& w){return w->m_isMapped;}
inline bool firstMap(const PHLWINDOW& w){return w->m_firstMap;}
inline PHLWINDOW parent(const PHLWINDOW& w){return w->parent();}
inline bool x11(const PHLWINDOW& w){return w->m_isX11;}
inline bool overrideRedirect(const PHLWINDOW& w){return w->isX11OverrideRedirect();}
inline bool floating(const PHLWINDOW& w){return w->m_isFloating;}
inline const SP<Desktop::View::CPopup>& popupHead(const PHLWINDOW& w){return w->m_popupHead;}
inline bool mapped(const SP<Desktop::View::CPopup>& p){return p->m_mapped;}
inline std::optional<uint32_t> xid(const PHLWINDOW& w){if(!w->m_isX11 || !w->m_xwaylandSurface)return std::nullopt;return w->m_xwaylandSurface->m_xID;}
#endif
#if CODEX_HYPRLAND_WORKSPACE_STATE
inline bool visible(const PHLWORKSPACE& w){return w->visible();}
// Workspaces are no longer marked inert; a referenced workspace stays valid
// (src/workspace/HLWorkspace.hpp: Workspace::valid).
inline bool inert(const PHLWORKSPACE& w){return !Workspace::valid(w);}
// The workspace as a window rule addresses it.
inline std::string spec(const PHLWORKSPACE& w){
    if(w->type()==Workspace::eWorkspaceType::SPECIAL)return w->addressableName();
    if(auto id=w->numberedID())return std::to_string(*id);
    return "name:"+w->addressableName();
}
#else
inline bool visible(const PHLWORKSPACE& w){return w->m_visible;}
inline bool inert(const PHLWORKSPACE& w){return w->inert();}
inline std::string spec(const PHLWORKSPACE& w){
    if(w->m_isSpecialWorkspace)return w->m_name;
    if(w->m_id>0)return std::to_string(w->m_id);
    return "name:"+w->m_name;
}
#endif
}
