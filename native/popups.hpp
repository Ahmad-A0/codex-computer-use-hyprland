// Isolate automation-created xdg_popup grabs from the physical desktop seat.
namespace Popups {
inline CFunctionHook* hook=nullptr;
inline CFunctionHook* motionHook=nullptr;
inline CFunctionHook* mapHook=nullptr;
inline int isolatedMap=0;
// Windows automation acted on, by time of the last action. Several providers
// may drive different windows at once, so this is not a single "last" window.
struct Touch { PHLWINDOWREF window; uint32_t at; };
inline std::vector<Touch> touched;
inline std::vector<WP<CXDGPopupResource>> owned;
inline CHyprSignalListener physicalButton;
inline void dismiss(){for(auto& weak:owned)if(auto popup=weak.lock())popup->done();owned.clear();}
inline void touch(PHLWINDOW window){
    std::erase_if(touched,[&](auto& t){auto w=t.window.lock();return !w || w==window || now()-t.at>=2000;});
    touched.push_back({window,now()});
}
inline bool recent(SP<Desktop::View::CWLSurface> surface){
    for(auto& t:touched)if(auto w=t.window.lock())if(now()-t.at<2000 && w->wlSurface()==surface)return true;
    return false;
}
// The toplevel surface whose popup tree contains this popup.
inline SP<CWLSurfaceResource> toplevel(SP<CXDGPopupResource> popup){
    auto parent=popup->m_parent.lock();
    for(int i=0;parent && i<64;++i){if(!parent->m_popup)return parent->m_surface.lock();parent=parent->m_popup->m_parent.lock();}
    return nullptr;
}
inline bool belongs(SP<CXDGPopupResource> popup,PHLWINDOW window){auto top=toplevel(popup);return top && top==window->wlSurface()->resource();}
inline bool ownedSurface(SP<CWLSurfaceResource> surface){
    for(auto& weak:owned)if(auto p=weak.lock())if(surface && p->m_surface && p->m_surface->m_surface.lock()==surface)return true;
    return false;
}
// A popup grab is the user's only when the user can have caused it: the input
// that opened it reached the client through the seat's keyboard or pointer
// focus. Any other grab request follows automation input, which reaches a
// client without seat focus, however long the app took to open its menu and
// whatever the user did meanwhile; a seat grab would steal the user's focus
// for a window they cannot see.
inline bool automated(SP<CXDGPopupResource> popup){
    auto top=toplevel(popup);
    if(!top)return false;  // Layer-shell and parentless popups are the desktop's.
    if(recent(Desktop::View::CWLSurface::fromResource(top)))return true;
    auto keyboard=g_pSeatManager->m_state.keyboardFocus.lock(),pointer=g_pSeatManager->m_state.pointerFocus.lock();
    return !(keyboard && keyboard->client()==top->client()) && !(pointer && pointer->client()==top->client());
}
inline void intercept(CXDGShellProtocol* protocol,SP<CXDGPopupResource> popup){
    std::erase_if(owned,[](auto& p){return p.expired();});
    if(automated(popup)){owned.emplace_back(popup);return;}
    dismiss();
    using Original=void(*)(CXDGShellProtocol*,SP<CXDGPopupResource>);
    reinterpret_cast<Original>(hook->m_original)(protocol,popup);
}
inline SP<CWLSurfaceResource> keyboardSurface(PHLWINDOW window){
    std::erase_if(owned,[](auto& p){return p.expired();});
    for(auto it=owned.rbegin();it!=owned.rend();++it)if(auto p=it->lock())if(belongs(p,window)&&p->m_surface && p->m_surface->m_mapped && p->m_surface->m_surface)return p->m_surface->m_surface.lock();
    return window->wlSurface()->resource();
}
inline void mapped(Desktop::View::CPopup* popup){
    auto surface=popup->wlSurface()?popup->wlSurface()->resource():nullptr;
    bool isolated=ownedSurface(surface) || recent(popup->getT1Owner());
    struct Scope{bool active;Scope(bool b):active(b){if(active)++isolatedMap;}~Scope(){if(active)--isolatedMap;}} scope{isolated};
    reinterpret_cast<void(*)(Desktop::View::CPopup*)>(mapHook->m_original)(popup);
}
// Whether the physical pointer can reach an open private popup: its window is
// being drawn. Popups of windows on hidden workspaces never are.
inline bool reachable(){
    for(auto& weak:owned)if(auto p=weak.lock()){
        auto top=Desktop::View::CWLSurface::fromResource(toplevel(p));
        auto window=top?Desktop::View::CWindow::fromView(top->view()):nullptr;
        if(!window || g_pHyprRenderer->shouldRenderWindow(window))return true;
    }
    return false;
}
inline void simulatedMotion(CInputManager* manager){
    std::erase_if(owned,[](auto& p){return p.expired();});
    if(isolatedMap || reachable())return;
    reinterpret_cast<void(*)(CInputManager*)>(motionHook->m_original)(manager);
}
inline void setup(HANDLE plugin){
    auto functions=HyprlandAPI::findFunctionsByName(plugin,"addOrStartGrab");require(functions.size()==1,"Cannot locate popup grab handler");
    hook=HyprlandAPI::createFunctionHook(plugin,functions[0].address,reinterpret_cast<void*>(intercept));require(hook&&hook->hook(),"Cannot install private popup routing");
    auto motions=HyprlandAPI::findFunctionsByName(plugin,"simulateMouseMovement");require(motions.size()==1,"Cannot locate compositor motion refresh");
    motionHook=HyprlandAPI::createFunctionHook(plugin,motions[0].address,reinterpret_cast<void*>(simulatedMotion));require(motionHook&&motionHook->hook(),"Cannot isolate popup motion refresh");
    auto maps=HyprlandAPI::findFunctionsByName(plugin,"CPopup5onMap");require(maps.size()==1,"Cannot locate popup mapping entry point");
    mapHook=HyprlandAPI::createFunctionHook(plugin,maps[0].address,reinterpret_cast<void*>(mapped));require(mapHook&&mapHook->hook(),"Cannot isolate popup mapping");
    // As on macOS, a click outside a menu closes it; typing elsewhere and
    // moving the pointer do not. A click on an open private popup is its own.
    physicalButton=Event::bus()->m_events.input.mouse.button.listen([](IPointer::SButtonEvent event,Event::SCallbackInfo&){
        if(event.state==WL_POINTER_BUTTON_STATE_PRESSED && !ownedSurface(g_pSeatManager->m_state.pointerFocus.lock()))dismiss();
    });
}
inline void clear(){dismiss();touched.clear();physicalButton.reset();if(hook){hook->unhook();hook=nullptr;}if(motionHook){motionHook->unhook();motionHook=nullptr;}if(mapHook){mapHook->unhook();mapHook=nullptr;}}
}
