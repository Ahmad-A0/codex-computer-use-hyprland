// Keys are encoded with a keymap sent to the target client just before them.
// GTK 3 reads a whole batch of protocol events before handling any of them and
// resolves key bindings (Ctrl+A, End, Escape...) by keycode against the keymap
// current when it handles the key, so a keymap restored right after the keys
// would apply to them. The client therefore keeps the map its keys were encoded
// with until it answers an xdg_wm_base ping sent after them (the X11 helper
// waits for _NET_WM_PING the same way), and then gets the seat's current
// keymap back. A physical key for the client restores it at once; a client
// that does not answer gets it back after a timeout.
namespace Keymap {
constexpr uint32_t TIMEOUT_MS=5000;
struct Barrier { WP<CWLSeatResource> seat; PHLWINDOWREF window; SP<IKeyboard> map; uint32_t serial=0; int outstanding=0; uint32_t deadline=0; };
inline std::vector<Barrier> barriers;
inline wl_protocol_logger* logger=nullptr;
inline wl_event_source *timer=nullptr,*idle=nullptr;
inline CHyprSignalListener physicalKey;

// The map the client has from keys still being processed, if any.
inline SP<IKeyboard> installed(const SP<CWLSeatResource>& seat){
    for(auto& b:barriers)if(b.seat.lock()==seat)return b.map;
    return nullptr;
}
inline void restore(const Barrier& b){
    auto seat=b.seat.lock();if(!seat)return;
    auto keyboard=g_pSeatManager->m_keyboard.lock();
    // A new keymap resets the client's modifier state: report it again.
    auto* held=Held::find(b.window.lock());
    auto heldMods=held?Held::mask(b.map->m_xkbKeymap,held->codes):0;
    auto focused=g_pSeatManager->m_state.keyboardFocus.lock();
    for(auto& weak:seat->m_keyboards)if(auto k=weak.lock()){
        k->sendKeymap(keyboard);
        if(keyboard && focused && focused->client()==seat->client()){auto m=keyboard->m_modifiersState;k->sendMods(m.depressed|heldMods,m.latched,m.locked,m.group);}
        else k->sendMods(heldMods,0,0,0);
    }
}
inline void unlog(){if(logger){wl_protocol_logger_destroy(logger);logger=nullptr;}}
// The timer fires at the earliest deadline, and stays off without barriers.
inline void rearm(){
    if(barriers.empty())unlog();
    int32_t wait=0;
    for(auto& b:barriers){auto left=std::max<int32_t>(1,int32_t(b.deadline-now())+1);wait=wait?std::min(wait,left):left;}
    if(timer)wl_event_source_timer_update(timer,wait);
}
// Restores every answered or expired barrier, or all of them.
inline void settle(bool all=false){
    std::vector<Barrier> done;
    std::erase_if(barriers,[&](auto& b){bool d=all || !b.seat || b.outstanding<=0 || int32_t(now()-b.deadline)>=0;if(d)done.push_back(b);return d;});
    for(auto& b:done)restore(b);
    rearm();
}
inline void schedule(){
    if(!idle)idle=wl_event_loop_add_idle(wl_display_get_event_loop(g_pCompositor->m_wlDisplay),[](void*){idle=nullptr;settle();},nullptr);
}
// Observes pongs without taking them from Hyprland, which ignores their serial.
inline void observe(void*,wl_protocol_logger_type type,const wl_protocol_logger_message* m){
    if(type!=WL_PROTOCOL_LOGGER_REQUEST || m->arguments_count<1 || std::strcmp(m->message->name,"pong") || std::strcmp(wl_resource_get_class(m->resource),"xdg_wm_base"))return;
    auto client=wl_resource_get_client(m->resource);
    for(auto& b:barriers)if(auto seat=b.seat.lock();seat && seat->client()==client && m->arguments[0].u==b.serial && --b.outstanding<=0)schedule();
}
// Called after keys encoded with `map` were queued for the client.
inline void arm(PHLWINDOW window,const SP<CWLSeatResource>& seat,const SP<IKeyboard>& map){
    std::vector<wl_resource*> bases;
    wl_client_for_each_resource(seat->client(),[](wl_resource* r,void* data){
        if(!std::strcmp(wl_resource_get_class(r),"xdg_wm_base"))static_cast<std::vector<wl_resource*>*>(data)->push_back(r);
        return WL_ITERATOR_CONTINUE;
    },&bases);
    auto it=std::ranges::find_if(barriers,[&](auto& b){return b.seat.lock()==seat;});
    if(bases.empty()){
        // Not an xdg-shell client: nothing to wait for.
        if(it!=barriers.end())barriers.erase(it);
        restore(Barrier{seat,window,map});
        rearm();
        return;
    }
    if(!logger)logger=wl_display_add_protocol_logger(g_pCompositor->m_wlDisplay,observe,nullptr);
    if(!logger){restore(Barrier{seat,window,map});return;}
    auto serial=wl_display_next_serial(g_pCompositor->m_wlDisplay);
    if(serial==1337)serial=wl_display_next_serial(g_pCompositor->m_wlDisplay);  // Hyprland's own ping serial
    // A later batch supersedes the earlier one: wait for the ping after it.
    if(it==barriers.end())it=barriers.insert(barriers.end(),Barrier{});
    *it=Barrier{seat,window,map,serial,int(bases.size()),now()+TIMEOUT_MS};
    for(auto* r:bases)wl_resource_post_event(r,0,serial);  // xdg_wm_base.ping
    rearm();
}
inline void setup(){
    timer=wl_event_loop_add_timer(wl_display_get_event_loop(g_pCompositor->m_wlDisplay),[](void*){settle();return 0;},nullptr);
    require(timer,"Cannot arm keymap restore timer");
    // The user's own keys are always read with the seat's keymap.
    physicalKey=Event::bus()->m_events.input.keyboard.key.listen([](IKeyboard::SKeyEvent,Event::SCallbackInfo&){
        auto focused=g_pSeatManager->m_state.keyboardFocus.lock();
        if(!focused)return;
        std::vector<Barrier> done;
        std::erase_if(barriers,[&](auto& b){auto seat=b.seat.lock();bool d=seat && seat->client()==focused->client();if(d)done.push_back(b);return d;});
        for(auto& b:done)restore(b);
        rearm();
    });
}
inline void clear(){
    settle(true);physicalKey.reset();
    if(idle){wl_event_source_remove(idle);idle=nullptr;}
    if(timer){wl_event_source_remove(timer);timer=nullptr;}
}
}
