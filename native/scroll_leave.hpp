#pragma once
// The pointer leave that ends a background scroll, sent once the client has
// handled the scroll. Qt dispatches wheel events after reading the whole batch
// of Wayland events, and drops them when the pointer has already left by then;
// a leave in a later batch lets it scroll like every other toolkit.
namespace ScrollLeave {
struct Pending {
    std::vector<WP<CWLPointerResource>> pointers;
    WP<CWLSurfaceResource> previous;
    Vector2D previousLocal;
};
inline wl_event_source* timer=nullptr;
inline std::optional<Pending> pending;

// Send the pending leave now (before any other synthetic pointer input).
inline void finish(){
    if(!pending)return;
    auto done=std::move(*pending);
    pending.reset();
    for(auto& weak:done.pointers) if(auto p=weak.lock()) {
        p->sendLeave();
        if(auto previous=done.previous.lock()) {p->sendEnter(previous,done.previousLocal);p->sendFrame();}
    }
}

inline void schedule(Pending next){
    finish();
    pending=std::move(next);
    if(!timer)timer=wl_event_loop_add_timer(wl_display_get_event_loop(g_pCompositor->m_wlDisplay),[](void*){finish();return 0;},nullptr);
    require(timer,"Cannot arm scroll leave timer");
    wl_event_source_timer_update(timer,100);
}

inline void clear(){finish();if(timer){wl_event_source_remove(timer);timer=nullptr;}}
}
