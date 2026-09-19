// Restore per-client keyboard routing after dispatch, and before physical input.
// Hyprland's window focus and seat focus are never modified.
namespace Routing {
inline std::vector<WP<CWLKeyboardResource>> pending;
inline WP<CWLSurfaceResource> target;
inline Vector2D physicalPosition;
inline CHyprSignalListener physicalKey, physicalMove, physicalButton, physicalAxis, focusChanged;
inline void restore() {
    target.reset();
    auto focused=g_pSeatManager->m_state.keyboardFocus.lock();
    auto keyboard=g_pSeatManager->m_keyboard.lock();
    std::vector<uint32_t> pressed;
    if(keyboard)for(uint32_t code=0;code<768;++code)if(keyboard->getPressed(code))pressed.push_back(code);
    wl_array held{pressed.size()*sizeof(uint32_t),pressed.size()*sizeof(uint32_t),pressed.data()};
    for(auto& weak:pending)if(auto resource=weak.lock()) {
        auto owner=resource->m_owner.lock();
        if(focused && owner && focused->client()==owner->client()) {
            resource->sendEnter(focused,&held);
            if(keyboard){auto m=keyboard->m_modifiersState;resource->sendMods(m.depressed,m.latched,m.locked,m.group);}
        } else resource->sendLeave();
    }
    pending.clear();
}
inline void hold(const std::vector<SP<CWLKeyboardResource>>& resources,SP<CWLSurfaceResource> surface) {
    pending.clear();
    for(auto& r:resources)pending.emplace_back(r);
    target=surface;physicalPosition=Pointer::mgr()->position().floor();
}
inline void setup() {
    physicalKey=Event::bus()->m_events.input.keyboard.key.listen([](IKeyboard::SKeyEvent,Event::SCallbackInfo&){restore();});
    physicalMove=Event::bus()->m_events.input.mouse.move.listen([](Vector2D position,Event::SCallbackInfo&){if(position!=physicalPosition)restore();});
    physicalButton=Event::bus()->m_events.input.mouse.button.listen([](IPointer::SButtonEvent,Event::SCallbackInfo&){restore();});
    physicalAxis=Event::bus()->m_events.input.mouse.axis.listen([](IPointer::SAxisEvent,Event::SCallbackInfo&){restore();});
    focusChanged=g_pSeatManager->m_events.keyboardFocusChange.listen([](){restore();});
}
inline void clear() {restore();physicalKey.reset();physicalMove.reset();physicalButton.reset();physicalAxis.reset();focusChanged.reset();}
}
