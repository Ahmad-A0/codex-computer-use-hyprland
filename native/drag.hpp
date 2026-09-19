// Application DND transactions are intercepted and routed without global seat DND.
namespace Drag {
inline CFunctionHook* hook=nullptr;
inline SP<CWLSurfaceResource> origin;
inline SP<CWLDataSourceResource> source;
inline WP<CWLSeatResource> seat;
inline std::vector<SP<CWLPointerResource>> pointers;
inline WP<CWLSurfaceResource> destination;
inline wl_resource* device=nullptr;
inline std::shared_ptr<Clipboard::DropResult> drop;
inline wl_event_source* deadline=nullptr;
inline CHyprSignalListener physicalButton;
inline bool dropped=false;
inline void restore() {
    auto actual=g_pSeatManager->m_state.pointerFocus.lock();Vector2D local;
    if(actual)if(auto wrapper=Desktop::View::CWLSurface::fromResource(actual))if(auto box=wrapper->getSurfaceBoxGlobal())local=Pointer::mgr()->position()-box->pos();
    for(auto& p:pointers){p->sendButton(now(),272,WL_POINTER_BUTTON_STATE_RELEASED);p->sendFrame();p->sendLeave();if(actual && p->m_owner && actual->client()==p->m_owner->client()){p->sendEnter(actual,local);p->sendFrame();}}
    pointers.clear();
}
inline void cancel() {
    if(deadline){wl_event_source_remove(deadline);deadline=nullptr;}
    if(source && (!drop||!drop->finished))source->cancelled();
    if(device && destination && !dropped)wl_data_device_send_leave(device);
    restore();origin.reset();source.reset();destination.reset();seat.reset();device=nullptr;drop.reset();dropped=false;
}
inline void intercept(CWLDataDeviceProtocol* protocol,WP<CWLDataSourceResource> requested,SP<CWLSurfaceResource> icon,SP<CWLSurfaceResource> requestedOrigin) {
    if(origin && requestedOrigin==origin) {source=requested.lock();return;}
    using Original=void(*)(CWLDataDeviceProtocol*,WP<CWLDataSourceResource>,SP<CWLSurfaceResource>,SP<CWLSurfaceResource>);
    reinterpret_cast<Original>(hook->m_original)(protocol,requested,icon,requestedOrigin);
}
inline void setup(HANDLE plugin) {
    auto matches=HyprlandAPI::findFunctionsByName(plugin,"_ZN22CWLDataDeviceProtocol12initiateDrag");
    if(matches.empty())matches=HyprlandAPI::findFunctionsByName(plugin,"initiateDrag");
    require(matches.size()==1,"Cannot locate exact Hyprland DND entry point");
    hook=HyprlandAPI::createFunctionHook(plugin,matches[0].address,reinterpret_cast<void*>(intercept));
    require(hook && hook->hook(),"Cannot install isolated DND routing hook");
    physicalButton=Event::bus()->m_events.input.mouse.button.listen([](IPointer::SButtonEvent,Event::SCallbackInfo&){if(origin)cancel();});
}
inline std::string begin(PHLWINDOW window,SP<CWLSeatResource> clientSeat,Vector2D point) {
    require(!origin,"Another background drag is active");
    Vector2D local;auto surface=Desktop::viewState()->hitTest().windowSurfaceAt(window->position(Desktop::View::IGeometric::GEOMETRIC_GOAL)+point,window,local);
    require(bool(surface),"No drag source at point");
    for(auto& weak:clientSeat->m_pointers)if(auto p=weak.lock())pointers.push_back(p);
    require(!pointers.empty(),"Drag source has no pointer resources");
    origin=surface;seat=clientSeat;
    deadline=wl_event_loop_add_timer(wl_display_get_event_loop(g_pCompositor->m_wlDisplay),[](void*){cancel();return 0;},nullptr);
    require(deadline,"Cannot arm drag cleanup timer");wl_event_source_timer_update(deadline,15000);
    for(auto& p:pointers){p->sendEnter(origin,local);p->sendMotion(now(),local);p->sendButton(now(),272,WL_POINTER_BUTTON_STATE_PRESSED);p->sendFrame();}
    return R"({"ok":true})";
}
inline std::string move(PHLWINDOW window,Vector2D point) {
    require(bool(origin),"No background drag is active");
    Vector2D local;auto hit=Desktop::viewState()->hitTest();auto position=window->position(Desktop::View::IGeometric::GEOMETRIC_GOAL)+point;
    auto surface=hit.windowSurfaceAt(position,window,local);
    if(source && !surface){if(device && destination)wl_data_device_send_leave(device);destination.reset();device=nullptr;drop.reset();return R"({"ok":true})";}
    if(!source) {
        auto wrapper=Desktop::View::CWLSurface::fromResource(origin);require(bool(wrapper),"Drag origin disappeared");auto box=wrapper->getSurfaceBoxGlobal();require(bool(box),"Drag origin geometry disappeared");
        for(auto& p:pointers){p->sendMotion(now(),position-box->pos());p->sendFrame();}
    } else {
        if(destination.lock()!=surface) {
            if(device && destination)wl_data_device_send_leave(device);
            auto found=Clipboard::devices(surface->client());require(!found.empty(),"Destination has no data device");
            device=found[0];destination=surface;drop=std::make_shared<Clipboard::DropResult>();
            auto offer=Clipboard::sendOffer(device,nullptr,source,drop);
            wl_data_device_send_enter(device,wl_display_next_serial(g_pCompositor->m_wlDisplay),surface->getResource()->resource(),wl_fixed_from_double(local.x),wl_fixed_from_double(local.y),offer);
        }
        wl_data_device_send_motion(device,now(),wl_fixed_from_double(local.x),wl_fixed_from_double(local.y));
    }
    return R"({"ok":true})";
}
inline std::string state(bool end=false) {
    require(bool(origin),"No background drag is active");
    if(end) {
        if(!source){cancel();return R"({"ok":true,"finished":true})";}
        require(device && destination && drop && drop->accepted,"Destination has not accepted this drag");
        drop->dropped=true;wl_data_device_send_drop(device);wl_data_device_send_leave(device);dropped=true;
    }
    bool finished=drop && drop->finished;
    std::string result=std::string("{\"ok\":true,\"dnd\":")+(source?"true":"false")+",\"accepted\":"+(drop&&drop->accepted?"true":"false")+",\"finished\":"+(finished?"true":"false")+"}";
    if(finished)cancel();
    return result;
}
inline void clear(){cancel();physicalButton.reset();if(hook){hook->unhook();hook=nullptr;}}
}
