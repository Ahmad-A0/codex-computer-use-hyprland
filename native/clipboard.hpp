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
    auto items=field(j,"items");require(json_object_is_type(items,json_type_object),"Expected clipboard MIME map");
    size_t total=0;
    json_object_object_foreach(items,key,value) {
        require(json_object_is_type(value,json_type_string),"Expected clipboard string");
        require(std::string(key)=="text/plain;charset=utf-8"||std::string(key)=="text/plain"||std::string(key)=="text/html"||std::string(key)=="text/markdown","Unsupported clipboard MIME type");
        std::string bytes(json_object_get_string(value),json_object_get_string_len(value));total+=bytes.size();
        require(total<1024*1024,"Clipboard payload exceeds limit");transfer->items[key]=std::move(bytes);
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
inline wl_event_source* watchdog=nullptr;
inline void setup() {
    watchdog=wl_event_loop_add_timer(wl_display_get_event_loop(g_pCompositor->m_wlDisplay),[](void*){
        for(auto it=transfers.begin();it!=transfers.end();) {
            auto t=it->second;
            if(now()-t->started<30000){++it;continue;}
            if(auto target=t->target.lock())for(auto* d:devices(target->client()))sendOffer(d,nullptr,g_pSeatManager->m_selection.currentSelection.lock());
            std::erase_if(writers,[&](auto& w){return w->transfer==t;});it=transfers.erase(it);
        }
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
    if(watchdog){wl_event_source_remove(watchdog);watchdog=nullptr;}
    for(auto& [id,t]:transfers) if(auto target=t->target.lock())
        for(auto* d:devices(target->client()))wl_data_device_send_selection(d,nullptr);
    writers.clear();transfers.clear();
    while(!offers.empty())wl_resource_destroy((*offers.begin())->resource);
}
}
