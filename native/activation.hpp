// Ignore activation requests caused by an isolated X11 drag, not physical input.
namespace Activation {
inline CFunctionHook *fullHook=nullptr,*rawHook=nullptr;
inline int pid=0;
inline uint32_t until=0,physicalUntil=0;
inline Vector2D position;
inline CHyprSignalListener motion;
inline bool active(){return pid && int32_t(until-now())>0;}
inline bool suppress(PHLWINDOW window,Desktop::eFocusReason reason){
    if(!active() || !window || Compat::pid(window)!=pid)return false;
    if(reason==Desktop::FOCUS_REASON_CLICK || reason==Desktop::FOCUS_REASON_KEYBIND || reason==Desktop::FOCUS_REASON_DISPATCH_FOCUSWINDOW)return false;
    if(reason==Desktop::FOCUS_REASON_FFM && int32_t(physicalUntil-now())>0)return false;
    return true;
}
inline void full(Desktop::CFocusState* state,PHLWINDOW window,Desktop::eFocusReason reason,SP<CWLSurfaceResource> surface,bool cycle){
    if(suppress(window,reason))return;
    reinterpret_cast<void(*)(Desktop::CFocusState*,PHLWINDOW,Desktop::eFocusReason,SP<CWLSurfaceResource>,bool)>(fullHook->m_original)(state,window,reason,surface,cycle);
}
inline void raw(Desktop::CFocusState* state,PHLWINDOW window,Desktop::eFocusReason reason,SP<CWLSurfaceResource> surface){
    if(suppress(window,reason))return;
    reinterpret_cast<void(*)(Desktop::CFocusState*,PHLWINDOW,Desktop::eFocusReason,SP<CWLSurfaceResource>)>(rawHook->m_original)(state,window,reason,surface);
}
inline void begin(PHLWINDOW window){pid=Compat::pid(window);until=now()+10000;physicalUntil=0;position=Pointer::mgr()->position().floor();}
inline void end(){until=now()+500;}
inline void setup(HANDLE plugin){
    auto install=[&](const char* name,void* handler){auto matches=HyprlandAPI::findFunctionsByName(plugin,name);require(matches.size()==1,"Cannot locate activation entry point");auto* hook=HyprlandAPI::createFunctionHook(plugin,matches[0].address,handler);require(hook&&hook->hook(),"Cannot isolate drag activation");return hook;};
    fullHook=install("fullWindowFocus",reinterpret_cast<void*>(full));rawHook=install("rawWindowFocus",reinterpret_cast<void*>(raw));
    motion=Event::bus()->m_events.input.mouse.move.listen([](Vector2D p,Event::SCallbackInfo&){if(p!=position){position=p;physicalUntil=now()+50;}});
}
inline void clear(){pid=0;motion.reset();if(fullHook){fullHook->unhook();fullHook=nullptr;}if(rawHook){rawHook->unhook();rawHook=nullptr;}}
}
