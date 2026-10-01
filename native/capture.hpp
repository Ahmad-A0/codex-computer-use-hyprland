// Render only a target's popup surfaces into isolated framebuffers.
namespace Capture {
struct Lease { PHLWINDOWREF window; uint32_t until; };
inline std::map<uint64_t,Lease> leases;
inline uint64_t serial=0;
inline wl_event_source* watchdog=nullptr;
inline void release(uint64_t token){
    auto it=leases.find(token);if(it==leases.end())return;
    auto window=it->second.window.lock();leases.erase(it);
    if(!window)return;
    for(auto& [_,lease]:leases)if(lease.window.lock()==window)return;
    window->setSuspended(window->isHidden() || !window->m_workspace || !window->m_workspace->m_visible);
}
inline std::string begin(PHLWINDOW window){
    require(leases.size()<64,"Too many concurrent capture requests");
    auto token=++serial;leases.emplace(token,Lease{window,now()+5000});
    window->setSuspended(false);
    return "{\"ok\":true,\"token\":"+std::to_string(token)+"}";
}
inline void setup(){
    watchdog=wl_event_loop_add_timer(wl_display_get_event_loop(g_pCompositor->m_wlDisplay),[](void*){
        std::vector<uint64_t> expired;for(auto& [token,lease]:leases)if(int32_t(lease.until-now())<=0)expired.push_back(token);
        for(auto token:expired)release(token);
        wl_event_source_timer_update(watchdog,250);return 0;
    },nullptr);
    require(watchdog,"Cannot arm capture cleanup timer");wl_event_source_timer_update(watchdog,250);
}
inline void clear(){if(watchdog){wl_event_source_remove(watchdog);watchdog=nullptr;}while(!leases.empty())release(leases.begin()->first);}
// A hidden client can be waiting for a frame callback indefinitely. Service
// only this window's surfaces; do not show it or alter the compositor seat.
inline std::string refresh(PHLWINDOW window){
    for(auto& [_,lease]:leases)if(lease.window.lock()==window){window->setSuspended(false);break;}
    size_t callbacks=0;
    auto pulse=[&](SP<CWLSurfaceResource> root){
        if(!root)return;
        root->breadthfirst([&](SP<CWLSurfaceResource> surface,const Vector2D&,void*){
            callbacks+=surface->m_current.callbacks.size();
            surface->frame(Time::steadyNow());
        },nullptr);
        wl_client_flush(root->client());
    };
    pulse(window->wlSurface()->resource());
    if(window->m_popupHead)window->m_popupHead->breadthfirst([&](SP<Desktop::View::CPopup> popup,void*){
        if(popup->m_mapped && popup->wlSurface())pulse(popup->wlSurface()->resource());
    },nullptr);
    return "{\"ok\":true,\"callbacks\":"+std::to_string(callbacks)+"}";
}
class MemoryBuffer final : public IHLBuffer {
 public:
    std::vector<uint8_t> bytes;
    explicit MemoryBuffer(Vector2D dimensions){size=dimensions;require(size.x>0 && size.y>0 && size.x*size.y<=16777216,"Popup capture exceeds limit");bytes.resize(size.x*size.y*4);}
    Aquamarine::eBufferCapability caps()override{return Aquamarine::BUFFER_CAPABILITY_DATAPTR;}
    Aquamarine::eBufferType type()override{return Aquamarine::BUFFER_TYPE_SHM;}
    void update(const CRegion&)override{}
    bool isSynchronous()override{return true;}
    bool good()override{return true;}
    Aquamarine::SSHMAttrs shm()override{return {.success=true,.format=DRM_FORMAT_ABGR8888,.size=size,.stride=int(size.x)*4};}
    std::tuple<uint8_t*,uint32_t,size_t> beginDataPtr(uint32_t)override{return {bytes.data(),DRM_FORMAT_ABGR8888,bytes.size()};}
    void endDataPtr()override{}
    void sendRelease()override{}
};
inline std::string popups(PHLWINDOW window,json_object* request){
    auto path=str(request,"path");auto runtime=getenv("XDG_RUNTIME_DIR");
    require(runtime && path.starts_with(std::string(runtime)+"/codex-cua-popup-"),"Invalid popup capture path");
    struct File{int fd;~File(){if(fd>=0)close(fd);}} file{open(path.c_str(),O_WRONLY|O_CLOEXEC|O_NOFOLLOW)};
    struct stat st{};require(file.fd>=0 && fstat(file.fd,&st)==0 && S_ISREG(st.st_mode) && st.st_uid==getuid() && !(st.st_mode&077),"Invalid popup capture file");
    Json result(json_object_new_object(),json_object_put);json_object_object_add(result.get(),"ok",json_object_new_boolean(true));auto list=json_object_new_array();json_object_object_add(result.get(),"popups",list);
    size_t offset=0;int count=0;
    window->m_popupHead->breadthfirst([&](SP<Desktop::View::CPopup> popup,void*){
        if(!popup->m_mapped || !popup->wlSurface() || !popup->wlSurface()->resource())return;
        require(++count<=16,"Too many popup surfaces");auto monitor=popup->getMonitor();require(bool(monitor),"Popup has no monitor");
        auto fb=g_pHyprRenderer->makeSnapshotFB(WP<Desktop::View::CPopup>(popup));require(bool(fb),"Cannot render popup surface");
        auto buffer=makeShared<MemoryBuffer>(fb->m_size);require(fb->readPixels(CHLBufferReference(buffer)),"Cannot read popup pixels");
        require(offset+buffer->bytes.size()<=128*1024*1024,"Popup captures exceed limit");
        for(size_t n=0;n<buffer->bytes.size();){auto written=write(file.fd,buffer->bytes.data()+n,buffer->bytes.size()-n);if(written<0&&errno==EINTR)continue;require(written>0,"Cannot write popup capture");n+=written;}
        auto item=json_object_new_object();auto number=[&](const char* key,double value){json_object_object_add(item,key,json_object_new_double(value));};
        auto position=popup->coordsGlobal();auto origin=window->position(Desktop::View::IGeometric::GEOMETRIC_GOAL);
        number("offset",offset);number("bytes",buffer->bytes.size());number("width",fb->m_size.x);number("height",fb->m_size.y);number("scale",monitor->m_scale);number("transform",monitor->m_transform);
        number("crop_x",position.x-monitor->m_position.x);number("crop_y",position.y-monitor->m_position.y);number("x",position.x-origin.x);number("y",position.y-origin.y);number("w",popup->size().x);number("h",popup->size().y);
        json_object_array_add(list,item);offset+=buffer->bytes.size();
    },nullptr);
    return json_object_to_json_string_ext(result.get(),JSON_C_TO_STRING_PLAIN);
}
}
