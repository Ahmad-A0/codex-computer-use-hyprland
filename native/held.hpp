// Per-window keys held across actions (Sky key_down/key_up). Only the target
// client's keyboard resources see them; the compositor seat and the physical
// keyboard state are never changed. Physical input, window close and plugin
// exit release them, as does the exit of the provider process that held them.
namespace Held {
struct State { PHLWINDOWREF window; WP<CWLSeatResource> seat; std::vector<uint32_t> codes; int owner=0; };
inline std::vector<State> states;
inline uint64_t epoch=0;  // Counts physical input so the provider can detect dropped holds.
inline Vector2D physicalPosition;
inline CHyprSignalListener physicalKey,physicalButton,physicalAxis,physicalMove;
inline wl_event_source* reaper=nullptr;
inline State* find(PHLWINDOW window){
    std::erase_if(states,[](auto& s){return !s.window || !Desktop::View::validMapped(s.window.lock()) || !s.seat;});
    for(auto& s:states)if(s.window.lock()==window)return &s;
    return nullptr;
}
inline uint32_t mask(xkb_keymap* map,const std::vector<uint32_t>& codes){
    if(codes.empty() || !map)return 0;
    auto* state=xkb_state_new(map);if(!state)return 0;
    for(auto code:codes)xkb_state_update_key(state,code+8,XKB_KEY_DOWN);
    auto mods=xkb_state_serialize_mods(state,XKB_STATE_MODS_DEPRESSED);xkb_state_unref(state);return mods;
}
inline wl_array array(std::vector<uint32_t>& codes){return wl_array{codes.size()*sizeof(uint32_t),codes.size()*sizeof(uint32_t),codes.data()};}
// Release holds and return each client to its real keyboard state.
inline void release(std::vector<State> released){
    auto focused=g_pSeatManager->m_state.keyboardFocus.lock();
    auto keyboard=g_pSeatManager->m_keyboard.lock();
    std::vector<uint32_t> pressed;
    if(keyboard)for(uint32_t code=0;code<768;++code)if(keyboard->getPressed(code))pressed.push_back(code);
    auto physical=array(pressed);
    for(auto& s:released)if(auto seat=s.seat.lock())for(auto& weak:seat->m_keyboards)if(auto k=weak.lock()){
        for(auto it=s.codes.rbegin();it!=s.codes.rend();++it)k->sendKey(now(),*it,WL_KEYBOARD_KEY_STATE_RELEASED);
        k->sendMods(0,0,0,0);
        if(focused && focused->client()==seat->client()){k->sendEnter(focused,&physical);if(keyboard){auto m=keyboard->m_modifiersState;k->sendMods(m.depressed,m.latched,m.locked,m.group);}}
        else k->sendLeave();
    }
}
// A provider that exited without key_up must not leave keys down.
inline void reap(){
    std::vector<State> orphaned;
    std::erase_if(states,[&](auto& s){bool dead=s.owner>0 && kill(s.owner,0)!=0 && errno==ESRCH;if(dead)orphaned.push_back(s);return dead;});
    if(!orphaned.empty())release(orphaned);
}
inline void drop(){auto released=std::move(states);states.clear();release(released);}
inline void physical(){++epoch;if(!states.empty())drop();}
inline void setup(){
    reaper=wl_event_loop_add_timer(wl_display_get_event_loop(g_pCompositor->m_wlDisplay),[](void*){reap();wl_event_source_timer_update(reaper,1000);return 0;},nullptr);
    require(reaper,"Cannot arm held-key cleanup timer");wl_event_source_timer_update(reaper,1000);
    physicalPosition=Pointer::mgr()->position().floor();
    physicalKey=Event::bus()->m_events.input.keyboard.key.listen([](IKeyboard::SKeyEvent,Event::SCallbackInfo&){physical();});
    physicalButton=Event::bus()->m_events.input.mouse.button.listen([](IPointer::SButtonEvent,Event::SCallbackInfo&){physical();});
    physicalAxis=Event::bus()->m_events.input.mouse.axis.listen([](IPointer::SAxisEvent,Event::SCallbackInfo&){physical();});
    physicalMove=Event::bus()->m_events.input.mouse.move.listen([](Vector2D position,Event::SCallbackInfo&){if(position.floor()!=physicalPosition){physicalPosition=position.floor();physical();}});
}
inline void clear(){if(reaper){wl_event_source_remove(reaper);reaper=nullptr;}drop();physicalKey.reset();physicalButton.reset();physicalAxis.reset();physicalMove.reset();}
}
