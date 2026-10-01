// Private wl_data_device offers: the compositor's global selection is never changed.
#include <wayland-server-core.h>
#include <unistd.h>
#include <fcntl.h>
#include <map>
#include <set>
#include <memory>

namespace Clipboard {
struct Transfer {
    WP<CWLSurfaceResource> target;
    std::map<std::string,std::string> items;
    unsigned received=0, completed=0, failed=0;
    uint32_t started=now();
};
struct DropResult {bool accepted=false,received=false,finished=false,dropped=false;};
struct Offer {
    wl_resource* resource=nullptr;
    std::shared_ptr<Transfer> transfer;
    SP<IDataSource> original;
    std::shared_ptr<DropResult> drop;
};
struct Writer {
    int fd=-1; size_t offset=0; std::string bytes;
    wl_event_source* event=nullptr;
    std::shared_ptr<Transfer> transfer;
    bool done=false;
    ~Writer() {if(event)wl_event_source_remove(event);if(fd>=0)close(fd);}
};
inline std::map<uint64_t,std::shared_ptr<Transfer>> transfers;
inline std::set<Offer*> offers;
inline std::vector<std::unique_ptr<Writer>> writers;
inline uint64_t serial=0;
inline void collect() {std::erase_if(writers,[](auto& w){return w->done;});}
inline int writeReady(int, uint32_t,void* data) {
    auto* w=static_cast<Writer*>(data);
    while(w->offset<w->bytes.size()) {
        auto n=write(w->fd,w->bytes.data()+w->offset,w->bytes.size()-w->offset);
        if(n>0) {w->offset+=n;continue;}
        if(n<0 && errno==EINTR)continue;
        if(n<0 && (errno==EAGAIN||errno==EWOULDBLOCK))return 0;
        ++w->transfer->failed;w->done=true;break;
    }
    if(!w->done) {++w->transfer->completed;w->done=true;}
    if(w->event) {wl_event_source_remove(w->event);w->event=nullptr;}
    close(w->fd);w->fd=-1;return 0;
}
inline void receive(wl_client*,wl_resource* resource,const char* mime,int fd) {
    auto* o=static_cast<Offer*>(wl_resource_get_user_data(resource));
    if(o->original) {if(o->drop)o->drop->received=true;o->original->send(mime,Hyprutils::OS::CFileDescriptor{fd});return;}
    auto found=o->transfer->items.find(mime);
    if(found==o->transfer->items.end()) {close(fd);return;}
    auto w=std::make_unique<Writer>();w->fd=fd;w->bytes=found->second;w->transfer=o->transfer;
    ++w->transfer->received;
    if(fcntl(fd,F_SETFL,fcntl(fd,F_GETFL)|O_NONBLOCK)<0) {++w->transfer->failed;return;}
    w->event=wl_event_loop_add_fd(wl_display_get_event_loop(g_pCompositor->m_wlDisplay),fd,WL_EVENT_WRITABLE,writeReady,w.get());
    if(!w->event) {++w->transfer->failed;return;}
    writeReady(fd,WL_EVENT_WRITABLE,w.get());writers.push_back(std::move(w));
}
inline const struct wl_data_offer_interface implementation={
    .accept=[](wl_client*,wl_resource* r,uint32_t,const char* mime){auto* o=static_cast<Offer*>(wl_resource_get_user_data(r));if(o->drop){o->drop->accepted=mime!=nullptr;o->original->accepted(mime?mime:"");}},
    .receive=receive,
    .destroy=[](wl_client*,wl_resource* r){wl_resource_destroy(r);},
    .finish=[](wl_client*,wl_resource* r){auto* o=static_cast<Offer*>(wl_resource_get_user_data(r));if(o->drop && o->drop->dropped && o->drop->accepted && !o->drop->finished){o->drop->finished=true;o->original->sendDndDropPerformed();o->original->sendDndFinished();}},
    .set_actions=[](wl_client*,wl_resource* r,uint32_t actions,uint32_t preferred){auto* o=static_cast<Offer*>(wl_resource_get_user_data(r));if(!o->drop)return;auto compatible=actions&o->original->actions();uint32_t chosen=compatible&preferred?preferred:compatible&WL_DATA_DEVICE_MANAGER_DND_ACTION_COPY?WL_DATA_DEVICE_MANAGER_DND_ACTION_COPY:compatible&WL_DATA_DEVICE_MANAGER_DND_ACTION_MOVE?WL_DATA_DEVICE_MANAGER_DND_ACTION_MOVE:0;wl_data_offer_send_action(r,chosen);o->original->sendDndAction(static_cast<wl_data_device_manager_dnd_action>(chosen));}
};
inline wl_resource* sendOffer(wl_resource* device,std::shared_ptr<Transfer> transfer,SP<IDataSource> original=nullptr,std::shared_ptr<DropResult> drop=nullptr) {
    if(!transfer && !original) {wl_data_device_send_selection(device,nullptr);return nullptr;}
    auto* resource=wl_resource_create(wl_resource_get_client(device),&wl_data_offer_interface,std::min(3,wl_resource_get_version(device)),0);
    require(resource,"Cannot allocate target clipboard offer");
    auto* offer=new Offer{resource,transfer,original,drop};offers.insert(offer);
    wl_resource_set_implementation(resource,&implementation,offer,[](wl_resource* r){auto* o=static_cast<Offer*>(wl_resource_get_user_data(r));if(o->drop && o->drop->dropped && o->drop->accepted && !o->drop->finished){o->drop->finished=true;o->original->sendDndDropPerformed();o->original->sendDndFinished();}offers.erase(o);delete o;});
    wl_data_device_send_data_offer(device,resource);
    if(original) {for(auto& mime:original->mimes())wl_data_offer_send_offer(resource,mime.c_str());}
    else {for(auto& [mime,data]:transfer->items)wl_data_offer_send_offer(resource,mime.c_str());}
    if(drop) {if(wl_resource_get_version(resource)>=3)wl_data_offer_send_source_actions(resource,original->actions());}
    else wl_data_device_send_selection(device,resource);
    return resource;
}
inline std::vector<wl_resource*> devices(wl_client* client) {
    std::vector<wl_resource*> result;
    wl_client_for_each_resource(client,[](wl_resource* r,void* p){
        if(std::string(wl_resource_get_class(r))=="wl_data_device")static_cast<std::vector<wl_resource*>*>(p)->push_back(r);
        return WL_ITERATOR_CONTINUE;
    },&result);
    return result;
}
inline std::string begin(SP<CWLSurfaceResource> target,json_object* j) {
    collect();require(transfers.empty(),"Another private clipboard transaction is active");
    auto found=devices(target->client());require(!found.empty(),"Application has no Wayland clipboard device");
    auto transfer=std::make_shared<Transfer>();transfer->target=target;
    json_object* blob=nullptr;
    if(json_object_object_get_ex(j,"blob",&blob)) {
        // A saved clipboard snapshot: arbitrary formats and bytes, read from a
        // private file written by the provider, as [mime, size] in file order.
        auto path=str(j,"blob");auto runtime=getenv("XDG_RUNTIME_DIR");
        require(runtime && path.starts_with(std::string(runtime)+"/codex-cua-request-"),"Invalid clipboard snapshot path");
        struct File {int fd;~File(){if(fd>=0)close(fd);}} file{open(path.c_str(),O_RDONLY|O_CLOEXEC|O_NOFOLLOW)};
        require(file.fd>=0,"Cannot open clipboard snapshot");struct stat st{};
        require(fstat(file.fd,&st)==0 && S_ISREG(st.st_mode) && st.st_uid==getuid() && (st.st_mode&077)==0 && st.st_size<=64*1024*1024,"Invalid clipboard snapshot file");
        auto formats=field(j,"formats");require(json_object_is_type(formats,json_type_array) && json_object_array_length(formats)<=128,"Expected at most 128 clipboard formats");
        off_t offset=0;
        for(size_t i=0;i<json_object_array_length(formats);++i) {
            auto* entry=json_object_array_get_idx(formats,i);require(json_object_is_type(entry,json_type_array) && json_object_array_length(entry)==2,"Expected [mime, size]");
            auto* mime=json_object_get_string(json_object_array_get_idx(entry,0));auto size=json_object_get_int64(json_object_array_get_idx(entry,1));
            std::string key=mime?mime:"";require(!key.empty() && key.size()<=255 && std::ranges::all_of(key,[](char c){return c>32 && c<127;}) && !transfer->items.contains(key),"Invalid clipboard MIME type");
            require(size>=0 && offset+size<=st.st_size,"Clipboard snapshot is truncated");
            std::string bytes(size,'\0');size_t done=0;
            while(done<bytes.size()){auto n=pread(file.fd,bytes.data()+done,bytes.size()-done,offset+done);if(n<0 && errno==EINTR)continue;require(n>0,"Cannot read clipboard snapshot");done+=n;}
            offset+=size;transfer->items[key]=std::move(bytes);
        }
    } else {
        auto items=field(j,"items");require(json_object_is_type(items,json_type_object),"Expected clipboard MIME map");
        size_t total=0;
        json_object_object_foreach(items,key,value) {
            require(json_object_is_type(value,json_type_string),"Expected clipboard string");
            require(std::string(key)=="text/plain;charset=utf-8"||std::string(key)=="text/plain"||std::string(key)=="text/html"||std::string(key)=="text/markdown","Unsupported clipboard MIME type");
            std::string bytes(json_object_get_string(value),json_object_get_string_len(value));total+=bytes.size();
            require(total<1024*1024,"Clipboard payload exceeds limit");transfer->items[key]=std::move(bytes);
        }
    }
    require(!transfer->items.empty(),"Empty clipboard MIME map");
    auto id=++serial;transfers[id]=transfer;
    for(auto* d:found)sendOffer(d,transfer);
    return "{\"ok\":true,\"token\":"+std::to_string(id)+"}";
}
inline std::string state(json_object* j,bool finish) {
    collect();auto id=static_cast<uint64_t>(num(j,"token"));auto found=transfers.find(id);
    require(found!=transfers.end(),"Unknown clipboard transaction");auto t=found->second;
    if(finish) {
        if(auto target=t->target.lock()) {
            auto selection=g_pSeatManager->m_selection.currentSelection.lock();
            for(auto* d:devices(target->client()))sendOffer(d,nullptr,selection);
        }
        transfers.erase(found);
    }
    return "{\"ok\":true,\"received\":"+std::to_string(t->received)+",\"completed\":"+std::to_string(t->completed)+",\"failed\":"+std::to_string(t->failed)+"}";
}
// Sky clipboard_read: while armed, the target client's new selection is kept
// private instead of replacing the desktop clipboard, then read and cancelled.
namespace Copy {
inline CFunctionHook* hook=nullptr;
inline wl_client* client=nullptr;
inline SP<IDataSource> source;
inline uint32_t started=0;
inline void end(){if(source)source->cancelled();source.reset();client=nullptr;}
// Hyprland leaves CWLDataSourceResource::m_device unset for most sources, so
// find the source among the target client's own wl_data_source resources.
inline bool owned(IDataSource* source){
    struct Search {IDataSource* source; bool found=false;} search{source};
    wl_client_for_each_resource(client,[](wl_resource* r,void* data){
        auto* s=static_cast<Search*>(data);
        if(std::string(wl_resource_get_class(r))=="wl_data_source" && CWLDataSourceResource::fromResource(r).get()==s->source){s->found=true;return WL_ITERATOR_STOP;}
        return WL_ITERATOR_CONTINUE;
    },&search);
    return search.found;
}
inline void intercept(CSeatManager* seat,SP<IDataSource> requested){
    if(client && requested && requested->type()==DATA_SOURCE_TYPE_WAYLAND && owned(requested.get())) {
        if(source && source!=requested)source->cancelled();
        source=requested;return;
    }
    reinterpret_cast<void(*)(CSeatManager*,SP<IDataSource>)>(hook->m_original)(seat,requested);
}
inline std::string begin(SP<CWLSurfaceResource> target){
    require(!client,"Another clipboard copy is active");
    client=target->client();started=now();source.reset();return R"({"ok":true})";
}
inline std::string state(){
    Json reply(json_object_new_object(),json_object_put);json_object_object_add(reply.get(),"ok",json_object_new_boolean(true));
    json_object_object_add(reply.get(),"active",json_object_new_boolean(client!=nullptr));
    json_object_object_add(reply.get(),"captured",json_object_new_boolean(bool(source)));
    auto* mimes=json_object_new_array();if(source)for(auto& mime:source->mimes())json_object_array_add(mimes,json_object_new_string(mime.c_str()));
    json_object_object_add(reply.get(),"mimes",mimes);
    return json_object_to_json_string_ext(reply.get(),JSON_C_TO_STRING_PLAIN);
}
// The provider opens the FIFO's read end first and reads until EOF, as wl-paste does.
inline std::string read(json_object* j){
    require(client && source,"No captured clipboard selection");
    auto mime=str(j,"mime");auto mimes=source->mimes();require(std::ranges::find(mimes,mime)!=mimes.end(),"Captured selection lacks that format");
    auto path=str(j,"path");auto runtime=getenv("XDG_RUNTIME_DIR");
    require(runtime && path.starts_with(std::string(runtime)+"/codex-cua-request-"),"Invalid clipboard pipe path");
    int fd=open(path.c_str(),O_WRONLY|O_NONBLOCK|O_CLOEXEC|O_NOFOLLOW);require(fd>=0,"Cannot open clipboard pipe");
    struct stat st{};if(fstat(fd,&st)!=0 || !S_ISFIFO(st.st_mode) || st.st_uid!=getuid()){close(fd);throw std::runtime_error("Invalid clipboard pipe");}
    fcntl(fd,F_SETFL,fcntl(fd,F_GETFL)&~O_NONBLOCK);
    source->send(mime,Hyprutils::OS::CFileDescriptor{fd});
    wl_client_flush(client);
    return R"({"ok":true})";
}
}
inline wl_event_source* watchdog=nullptr;
inline void setup(HANDLE plugin) {
    auto matches=HyprlandAPI::findFunctionsByName(plugin,"12CSeatManager19setCurrentSelection");
    require(matches.size()==1,"Cannot locate exact Hyprland selection entry point");
    Copy::hook=HyprlandAPI::createFunctionHook(plugin,matches[0].address,reinterpret_cast<void*>(Copy::intercept));
    require(Copy::hook && Copy::hook->hook(),"Cannot install private copy hook");
    watchdog=wl_event_loop_add_timer(wl_display_get_event_loop(g_pCompositor->m_wlDisplay),[](void*){
        for(auto it=transfers.begin();it!=transfers.end();) {
            auto t=it->second;
            if(now()-t->started<30000){++it;continue;}
            if(auto target=t->target.lock())for(auto* d:devices(target->client()))sendOffer(d,nullptr,g_pSeatManager->m_selection.currentSelection.lock());
            std::erase_if(writers,[&](auto& w){return w->transfer==t;});it=transfers.erase(it);
        }
        if(Copy::client && now()-Copy::started>=30000)Copy::end();
        collect();wl_event_source_timer_update(watchdog,1000);return 0;
    },nullptr);
    require(watchdog,"Cannot arm clipboard cleanup timer");wl_event_source_timer_update(watchdog,1000);
}
inline void drain() {
    require(transfers.empty(),"Clipboard transaction still active");collect();require(writers.empty(),"Clipboard transfer still active");
    std::set<wl_client*> clients;
    for(auto* o:offers)clients.insert(wl_resource_get_client(o->resource));
    for(auto* client:clients)for(auto* d:devices(client))wl_data_device_send_selection(d,nullptr);
    // Restore the physical keyboard client's ordinary compositor offer.
    g_pSeatManager->m_events.setSelection.emit();
}
inline void clear() {
    Copy::end();if(Copy::hook){Copy::hook->unhook();Copy::hook=nullptr;}
    if(watchdog){wl_event_source_remove(watchdog);watchdog=nullptr;}
    for(auto& [id,t]:transfers) if(auto target=t->target.lock())
        for(auto* d:devices(target->client()))wl_data_device_send_selection(d,nullptr);
    writers.clear();transfers.clear();
    while(!offers.empty())wl_resource_destroy((*offers.begin())->resource);
}
}
