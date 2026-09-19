// Isolate automation-created xdg_popup grabs from the physical desktop seat.
namespace Popups {
inline CFunctionHook* hook=nullptr;
inline CFunctionHook* motionHook=nullptr;
inline CFunctionHook* mapHook=nullptr;
inline int isolatedMap=0;
inline Vector2D physicalPosition;
inline PHLWINDOWREF recent;
inline uint32_t touched=0;
inline std::vector<WP<CXDGPopupResource>> owned;
inline CHyprSignalListener physicalKey,physicalButton,physicalMove;
inline void dismiss(){for(auto& weak:owned)if(auto popup=weak.lock())popup->done();owned.clear();recent.reset();}
inline void touch(PHLWINDOW window){recent=window;touched=now();physicalPosition=Pointer::mgr()->position().floor();}
inline bool belongs(SP<CXDGPopupResource> popup,PHLWINDOW window){
    auto parent=popup->m_parent.lock();
    for(int i=0;parent && i<64;++i){if(parent->m_surface.lock()==window->wlSurface()->resource())return true;if(!parent->m_popup)break;parent=parent->m_popup->m_parent.lock();}
    return false;
}
inline void intercept(CXDGShellProtocol* protocol,SP<CXDGPopupResource> popup){
    if(recent && now()-touched<2000 && belongs(popup,recent.lock())){owned.emplace_back(popup);return;}
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
    bool isolated=recent && now()-touched<2000 && popup->getT1Owner()==recent->wlSurface();
    struct Scope{bool active;Scope(bool b):active(b){if(active)++isolatedMap;}~Scope(){if(active)--isolatedMap;}} scope{isolated};
    reinterpret_cast<void(*)(Desktop::View::CPopup*)>(mapHook->m_original)(popup);
}
inline void simulatedMotion(CInputManager* manager){
    std::erase_if(owned,[](auto& p){return p.expired();});
    if(isolatedMap || !owned.empty())return;
    reinterpret_cast<void(*)(CInputManager*)>(motionHook->m_original)(manager);
}
inline void setup(HANDLE plugin){
    auto functions=HyprlandAPI::findFunctionsByName(plugin,"addOrStartGrab");require(functions.size()==1,"Cannot locate popup grab handler");
    hook=HyprlandAPI::createFunctionHook(plugin,functions[0].address,reinterpret_cast<void*>(intercept));require(hook&&hook->hook(),"Cannot install private popup routing");
    auto motions=HyprlandAPI::findFunctionsByName(plugin,"simulateMouseMovement");require(motions.size()==1,"Cannot locate compositor motion refresh");
    motionHook=HyprlandAPI::createFunctionHook(plugin,motions[0].address,reinterpret_cast<void*>(simulatedMotion));require(motionHook&&motionHook->hook(),"Cannot isolate popup motion refresh");
    auto maps=HyprlandAPI::findFunctionsByName(plugin,"CPopup5onMap");require(maps.size()==1,"Cannot locate popup mapping entry point");
    mapHook=HyprlandAPI::createFunctionHook(plugin,maps[0].address,reinterpret_cast<void*>(mapped));require(mapHook&&mapHook->hook(),"Cannot isolate popup mapping");
    physicalKey=Event::bus()->m_events.input.keyboard.key.listen([](IKeyboard::SKeyEvent,Event::SCallbackInfo&){dismiss();});
    physicalButton=Event::bus()->m_events.input.mouse.button.listen([](IPointer::SButtonEvent,Event::SCallbackInfo&){dismiss();});
    physicalMove=Event::bus()->m_events.input.mouse.move.listen([](Vector2D position,Event::SCallbackInfo&){if(position!=physicalPosition)dismiss();});
}
inline void clear(){dismiss();physicalKey.reset();physicalButton.reset();physicalMove.reset();if(hook){hook->unhook();hook=nullptr;}if(motionHook){motionHook->unhook();motionHook=nullptr;}if(mapHook){mapHook->unhook();mapHook=nullptr;}}
}
