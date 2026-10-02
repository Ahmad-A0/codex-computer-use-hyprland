// Window-targeted Wayland events. Never changes the compositor's focus or cursor.
#include <hyprland/src/plugins/PluginAPI.hpp>
#include <hyprland/src/Compositor.hpp>
#include <hyprland/src/desktop/state/ViewState.hpp>
#include <hyprland/src/desktop/state/FocusState.hpp>
#include <hyprland/src/desktop/view/Window.hpp>
#include <hyprland/src/desktop/view/WLSurface.hpp>
#include <hyprland/src/managers/SeatManager.hpp>
#include <hyprland/src/managers/SessionLockManager.hpp>
#include <hyprland/src/managers/input/InputManager.hpp>
#include <hyprland/src/pointer/PointerManager.hpp>
#include <hyprland/src/protocols/core/Seat.hpp>
#include <hyprland/src/protocols/core/Compositor.hpp>
#include <hyprland/src/protocols/core/DataDevice.hpp>
#include <hyprland/src/devices/IKeyboard.hpp>
#include <hyprland/src/event/EventBus.hpp>
#include <hyprland/src/desktop/view/Popup.hpp>
#include <hyprland/src/xwayland/XWayland.hpp>
#include <hyprland/src/protocols/XDGShell.hpp>
#include <hyprland/src/render/Renderer.hpp>
#include <hyprland/src/output/Monitor.hpp>
#include <hyprland/src/desktop/rule/windowRule/WindowRuleApplicator.hpp>
#include <hyprland/src/desktop/state/WindowState.hpp>
#include <hyprland/src/layout/target/Target.hpp>
#include <hyprland/src/layout/space/Space.hpp>
#include <json-c/json.h>
#include <cerrno>
#include <chrono>
#include <csignal>
#include <cmath>
#include <memory>
#include <stdexcept>
#include <sstream>
#include <iomanip>
#include <wayland-server-core.h>
#include <unistd.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <map>
#include <set>
#include <fstream>
#include <ranges>

namespace {
using Json = std::unique_ptr<json_object, decltype(&json_object_put)>;
uint32_t now() { return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now().time_since_epoch()).count(); }
void require(bool ok, const char* error) { if (!ok) throw std::runtime_error(error); }
json_object* field(json_object* j, const char* key) { json_object* v = nullptr; require(json_object_object_get_ex(j,key,&v), "Missing request field"); return v; }
std::string str(json_object* j,const char* key) { auto v=field(j,key); require(json_object_is_type(v,json_type_string),"Expected string"); return json_object_get_string(v); }
double num(json_object* j,const char* key) { auto v=field(j,key); require(json_object_is_type(v,json_type_double)||json_object_is_type(v,json_type_int),"Expected number"); auto n=json_object_get_double(v); require(std::isfinite(n),"Nonfinite number"); return n; }

#include "clipboard.hpp"
#include "focus_restore.hpp"
#include "held.hpp"
#include "popups.hpp"
#include "activation.hpp"
#include "capture.hpp"
#include "drag.hpp"
#include "placement.hpp"

struct TextKeyboard final : IKeyboard {
    bool isVirtual() override { return true; }
    SP<Aquamarine::IKeyboard> aq() override { return nullptr; }
    explicit TextKeyboard(const std::string& symbols) {
        auto ctx=xkb_context_new(XKB_CONTEXT_NO_FLAGS);
        require(ctx,"Cannot allocate XKB context");
        std::string map="xkb_keymap { xkb_keycodes { include \"evdev+aliases(qwerty)\" }; xkb_types { include \"complete\" }; xkb_compatibility { include \"complete\" }; xkb_symbols { include \"pc+us+inet(evdev)\" "+symbols+" }; };";
        m_xkbKeymap=xkb_keymap_new_from_string(ctx,map.c_str(),XKB_KEYMAP_FORMAT_TEXT_V1,XKB_KEYMAP_COMPILE_NO_FLAGS);
        xkb_context_unref(ctx);
        require(m_xkbKeymap,"Cannot compile target keyboard map");
        updateKeymapFD();
    }
};
struct Stroke { uint32_t code, mods; };
Stroke lookup(xkb_keymap* map,xkb_keysym_t sym) {
    for (auto code=xkb_keymap_min_keycode(map);code<=xkb_keymap_max_keycode(map);++code) {
        for (xkb_level_index_t level=0;level<xkb_keymap_num_levels_for_key(map,code,0);++level) {
            const xkb_keysym_t* syms=nullptr;
            if(xkb_keymap_key_get_syms_by_level(map,code,0,level,&syms)!=1 || (syms[0]!=sym && (!xkb_keysym_to_utf32(sym) || xkb_keysym_to_utf32(syms[0])!=xkb_keysym_to_utf32(sym)))) continue;
            xkb_mod_mask_t masks[16];
            auto count=xkb_keymap_key_get_mods_for_level(map,code,0,level,masks,16);
            if(count) return {code-8,masks[0]};
        }
    }
    throw std::runtime_error("Key is absent from target keymap: " + std::to_string(sym));
}
std::vector<uint32_t> decode(const std::string& text) {
    std::vector<uint32_t> result;
    for(size_t i=0;i<text.size();) {
        unsigned char a=text[i++]; uint32_t cp; int n;
        if(a<128) {cp=a;n=0;} else if(a>=0xc2 && a<0xe0) {cp=a&31;n=1;}
        else if(a<0xf0 && a>=0xe0) {cp=a&15;n=2;} else if(a>=0xf0 && a<=0xf4) {cp=a&7;n=3;} else throw std::runtime_error("Invalid UTF-8");
        for(int k=0;k<n;++k) { require(i<text.size(),"Incomplete UTF-8"); unsigned char b=text[i++]; require((b&192)==128,"Invalid UTF-8 continuation"); cp=(cp<<6)|(b&63); }
        require(cp && cp<=0x10ffff && !(cp>=0xd800 && cp<=0xdfff) && !(n==1&&cp<128) && !(n==2&&cp<2048) && !(n==3&&cp<65536),"Invalid Unicode scalar");
        result.push_back(cp);
    }
    return result;
}

void keyboard(PHLWINDOW window,SP<CWLSeatResource> seat,json_object* j,const std::string& op) {
    auto target=Popups::keyboardSurface(window);
    if(Routing::target.lock()!=target)Routing::restore();
    auto original=g_pSeatManager->m_keyboard.lock();
    require(original && original->m_xkbKeymap,"No physical keyboard map");
    auto previous=g_pSeatManager->m_state.keyboardFocus.lock();
    std::vector<SP<CWLKeyboardResource>> resources;
    for(auto& weak:seat->m_keyboards) if(auto k=weak.lock()) resources.push_back(k);
    require(!resources.empty(),"Application has no Wayland keyboard resource");
    SP<IKeyboard> map=original;
    std::vector<Stroke> strokes;
    // Held keys stay down for this window: re-entry reports them, and every
    // stroke carries their modifiers. "hold" replaces the held set in order.
    auto* held=Held::find(window);
    std::vector<uint32_t> before=held?held->codes:std::vector<uint32_t>{},after=before;
    if(op=="hold") {
        auto keys=field(j,"keys");require(json_object_is_type(keys,json_type_array) && json_object_array_length(keys)<=16,"Expected at most 16 held keys");
        after.clear();
        for(size_t i=0;i<json_object_array_length(keys);++i) {
            auto* name=json_object_get_string(json_object_array_get_idx(keys,i));require(name,"Expected key name");
            auto sym=xkb_keysym_from_name(name,XKB_KEYSYM_CASE_INSENSITIVE);require(sym!=XKB_KEY_NoSymbol,"Unknown XKB key name");
            auto code=lookup(original->m_xkbKeymap,sym).code;
            if(std::find(after.begin(),after.end(),code)==after.end())after.push_back(code);
        }
    }
    const auto heldMods=Held::mask(original->m_xkbKeymap,after);
    if(op=="text") {
        auto chars=decode(str(j,"text")); require(chars.size()<=2048,"Text batch too large");
        std::vector<uint32_t> extras;
        for(auto cp:chars) if(cp>126 && std::find(extras.begin(),extras.end(),cp)==extras.end()) extras.push_back(cp);
        require(extras.size()<=48,"Too many distinct Unicode scalars in one batch");
        auto base=makeShared<TextKeyboard>("");
        std::ostringstream symbols;
        for(size_t i=0;i<extras.size();++i) symbols<<"replace key <"<<xkb_keymap_key_get_name(base->m_xkbKeymap,200+i)<<"> { [ U"<<std::hex<<std::setw(4)<<std::setfill('0')<<extras[i]<<std::dec<<" ] }; ";
        map=makeShared<TextKeyboard>(symbols.str());
        for(auto cp:chars) {
            auto sym=cp=='\n'||cp=='\r'?XKB_KEY_Return:cp=='\t'?XKB_KEY_Tab:xkb_utf32_to_keysym(cp);
            require(sym!=XKB_KEY_NoSymbol,"Unsupported text character");
            strokes.push_back(lookup(map->m_xkbKeymap,sym));
        }
    } else if(op=="key") {
        auto sym=xkb_keysym_from_name(str(j,"key").c_str(),XKB_KEYSYM_CASE_INSENSITIVE);
        require(sym!=XKB_KEY_NoSymbol,"Unknown XKB key name");
        auto stroke=lookup(map->m_xkbKeymap,sym);
        auto mods=field(j,"modifiers"); require(json_object_is_type(mods,json_type_array),"Expected modifiers array");
        for(size_t i=0;i<json_object_array_length(mods);++i) {
            std::string name=json_object_get_string(json_object_array_get_idx(mods,i));
            auto index=xkb_keymap_mod_get_index(map->m_xkbKeymap,name.c_str());
            require(index!=XKB_MOD_INVALID && index<32,"Unknown keyboard modifier"); stroke.mods|=1u<<index;
        }
        strokes.push_back(stroke);
    }
    // All fallible preparation precedes delivery. These calls only enqueue protocol events.
    auto entered=Held::array(before);
    for(auto& k:resources) {
        k->sendKeymap(map); if(op=="probe_clear")k->sendLeave();else k->sendEnter(target,&entered);
        if(op=="hold") {
            std::vector<uint32_t> down=before;
            for(auto it=before.rbegin();it!=before.rend();++it)if(std::find(after.begin(),after.end(),*it)==after.end()){std::erase(down,*it);k->sendKey(now(),*it,WL_KEYBOARD_KEY_STATE_RELEASED);k->sendMods(Held::mask(original->m_xkbKeymap,down),0,0,0);}
            for(auto code:after)if(std::find(down.begin(),down.end(),code)==down.end()){down.push_back(code);k->sendKey(now(),code,WL_KEYBOARD_KEY_STATE_PRESSED);k->sendMods(Held::mask(original->m_xkbKeymap,down),0,0,0);}
        }
        for(auto s:strokes) { k->sendMods(s.mods|heldMods,0,0,0); k->sendKey(now(),s.code,WL_KEYBOARD_KEY_STATE_PRESSED); k->sendKey(now(),s.code,WL_KEYBOARD_KEY_STATE_RELEASED); }
        k->sendMods(heldMods,0,0,0); k->sendKeymap(original);
        if(previous==target) {auto m=original->m_modifiersState;k->sendMods(m.depressed|heldMods,m.latched,m.locked,m.group);}
    }
    if(op=="hold") {
        if(held && after.empty())std::erase_if(Held::states,[&](auto& s){return &s==held;});
        json_object* owner=nullptr;int pid=json_object_object_get_ex(j,"owner",&owner)?json_object_get_int(owner):0;
        if(held){held->codes=after;held->owner=pid;}
        else if(!after.empty())Held::states.push_back({window,seat,after,pid});
    }
    if(op=="probe" || op=="probe_clear" || (previous && previous!=target && previous->client()==seat->client())) Routing::hold(resources,target);
}

std::string handle(eHyprCtlOutputFormat,std::string request) {
    try {
        auto start=request.find('{'); require(start!=std::string::npos && request.size()<131072,"Invalid request envelope");
        Json j(json_tokener_parse(request.c_str()+start),json_object_put); require(bool(j),"Invalid JSON");
        auto op=str(j.get(),"op");
        if(op=="request_file") {
            auto path=str(j.get(),"path");auto runtime=getenv("XDG_RUNTIME_DIR");
            require(runtime && path.starts_with(std::string(runtime)+"/codex-cua-request-"),"Invalid request file path");
            struct File {int fd;~File(){if(fd>=0)close(fd);}} file{open(path.c_str(),O_RDONLY|O_CLOEXEC|O_NOFOLLOW)};
            require(file.fd>=0,"Cannot open request file");struct stat st{};
            require(fstat(file.fd,&st)==0 && S_ISREG(st.st_mode) && st.st_uid==getuid() && (st.st_mode&077)==0 && st.st_size>0 && st.st_size<=2*1024*1024,"Invalid request file");
            std::string data(st.st_size,'\0');size_t offset=0;
            while(offset<data.size()){auto n=read(file.fd,data.data()+offset,data.size()-offset);if(n<0 && errno==EINTR)continue;require(n>0,"Cannot read request file");offset+=n;}
            j.reset(json_tokener_parse(data.c_str()));require(bool(j),"Invalid request file JSON");op=str(j.get(),"op");
        }
        if(op=="status") return std::string("{\"ok\":true,\"version\":2,\"build\":\"")+CODEX_BUILD_ID+"\",\"offers\":"+std::to_string(Clipboard::offers.size())+",\"busy\":"+(Drag::origin || !Clipboard::transfers.empty() || Clipboard::Copy::client || !Capture::leases.empty() || Activation::active()?"true":"false")+",\"epoch\":"+std::to_string(Held::epoch)+",\"holds\":"+std::to_string(Held::states.size())+",\"placed\":"+std::to_string(Placement::placed)+"}";
        if(op=="drain"){require(!Drag::origin && !Activation::active() && Capture::leases.empty(),"Input or capture still active");Clipboard::Copy::end();Held::drop();Popups::dismiss();Clipboard::drain();Routing::restore();return R"({"ok":true})";}
        if(op=="drag_status" || op=="drag_end"){if(op=="drag_end"){require(!g_pSessionLockManager->isSessionLocked(),"Session locked");require(!g_pInputManager->hasHeldButtons(),"Physical mouse button held");}return Drag::state(op=="drag_end");}
        if(op=="activation_end"){Activation::end();return R"({"ok":true})";}
        if(op=="ax_probe_end"){Routing::restore();return R"({"ok":true})";}
        if(op=="drag_cancel"){Drag::cancel();return R"({"ok":true})";}
        if(op=="paste_status"||op=="paste_end") return Clipboard::state(j.get(),op=="paste_end");
        if(op=="copy_status") return Clipboard::Copy::state();
        if(op=="copy_read") return Clipboard::Copy::read(j.get());
        if(op=="copy_end"){Clipboard::Copy::end();return R"({"ok":true})";}
        if(op=="launched")return Placement::launched(j.get());
        if(op=="refresh_end"){Capture::release(num(j.get(),"token"));return R"({"ok":true})";}
        auto window=Desktop::viewState()->query().selector("address:"+str(j.get(),"address")).runWindow();
        require(window && Desktop::View::validMapped(window),"Target is not mapped");

        if(op=="refresh_begin"){require(!g_pSessionLockManager->isSessionLocked(),"Session locked");return Capture::begin(window);}
        if(op=="refresh"){require(!g_pSessionLockManager->isSessionLocked(),"Session locked");return Capture::refresh(window);}
        if(op=="popup_capture"){require(!g_pSessionLockManager->isSessionLocked(),"Session locked");return Capture::popups(window,j.get());}
        if(op=="popup_list")return Capture::list(window);
        require(window->acceptsInput(),"Target refuses input");
        require(!g_pSessionLockManager->isSessionLocked(),"Session locked");
        require(!g_pInputManager->hasHeldButtons(),"Physical mouse button held");
        require(!(PROTO::data && PROTO::data->dndActive()),"Drag-and-drop active");
        if(op=="activation_begin"){Activation::begin(window);return R"({"ok":true})";}
        if(op=="x11_info") {
            require(window->m_isX11 && bool(window->m_xwaylandSurface),"Target is not XWayland");
            Json reply(json_object_new_object(),json_object_put);
            json_object_object_add(reply.get(),"ok",json_object_new_boolean(true));
            json_object_object_add(reply.get(),"xid",json_object_new_int64(window->m_xwaylandSurface->m_xID));
            json_object_object_add(reply.get(),"display",json_object_new_string(getenv("DISPLAY")));
            json_object_object_add(reply.get(),"compositor_pid",json_object_new_int64(getpid()));
            json_object_object_add(reply.get(),"clipboard_empty",json_object_new_boolean(!g_pSeatManager->m_selection.currentSelection));
            auto selection=g_pSeatManager->m_selection.currentSelection.lock();
            json_object_object_add(reply.get(),"clipboard_wayland",json_object_new_boolean(selection && selection->type()==DATA_SOURCE_TYPE_WAYLAND));
            json_object_object_add(reply.get(),"clipboard_identity",json_object_new_string(std::to_string(reinterpret_cast<uintptr_t>(selection.get())).c_str()));
            return json_object_to_json_string_ext(reply.get(),JSON_C_TO_STRING_PLAIN);
        }
        if(op=="prepare_action"){
            Activation::begin(window);Popups::touch(window);
            if(!window->m_isX11){auto surface=window->wlSurface()->resource();auto resource=g_pSeatManager->seatResourceForClient(surface->client());require(bool(resource),"Application has no seat");keyboard(window,resource,j.get(),"focus");}
            return R"({"ok":true})";
        }
        require(!window->m_isX11 || op=="paste_begin","XWayland requires the targeted X11 helper");
        if(op=="click" || op=="key" || op=="text" || op=="move" || op=="scroll" || op=="hold")Popups::touch(window);
        auto main=window->wlSurface()->resource(); require(bool(main),"Target has no surface");
        auto seat=g_pSeatManager->seatResourceForClient(main->client()); require(bool(seat),"Target has no seat");
        // Pointer input to a window with held keys also routes its keyboard,
        // so the client applies the held modifiers to the pointer events.
        json_object* focus=nullptr;
        if(op=="click" || ((op=="scroll" || op=="move" || op=="drag" || op=="drag_begin") && Held::find(window)) || (op=="drag_begin" && json_object_object_get_ex(j.get(),"focus",&focus) && json_object_get_boolean(focus)))keyboard(window,seat,j.get(),"focus");
        if(op=="drag_begin" || op=="drag_move") {
            Vector2D point{num(j.get(),"x"),num(j.get(),"y")};
            require(!g_pSeatManager->m_seatGrab,"Seat grab active");
            if(op=="drag_move")return Drag::move(window,point);
            json_object *button=nullptr,*timeout=nullptr;uint32_t code=272,lifetime=15000;
            if(json_object_object_get_ex(j.get(),"button",&button)){std::string b=json_object_get_string(button);require(b=="left"||b=="right"||b=="middle","Invalid button");code=b=="right"?273:b=="middle"?274:272;}
            if(json_object_object_get_ex(j.get(),"timeout",&timeout)){auto ms=num(j.get(),"timeout");require(ms>=1000 && ms<=600000,"Invalid drag timeout");lifetime=ms;}
            return Drag::begin(window,seat,point,code,lifetime);
        }
        if(op=="copy_begin"){keyboard(window,seat,j.get(),"focus");return Clipboard::Copy::begin(main);}
        if(op=="ax_probe" || op=="ax_probe_clear"){require(!g_pSeatManager->m_seatGrab,"Seat grab active");keyboard(window,seat,j.get(),op=="ax_probe"?"probe":"probe_clear");return R"({"ok":true})";}
        if(op=="paste_begin") {require(!g_pSeatManager->m_seatGrab || g_pSeatManager->m_seatGrab->accepts(main),"Unrelated seat grab active");keyboard(window,seat,j.get(),"focus");return Clipboard::begin(main,j.get());}
        if(op=="text" || op=="key" || op=="hold") { require(!g_pSeatManager->m_seatGrab || g_pSeatManager->m_seatGrab->accepts(main),"Unrelated seat grab active");keyboard(window,seat,j.get(),op); return R"({"ok":true,"epoch":)"+std::to_string(Held::epoch)+"}"; }
        require(op=="click"||op=="scroll"||op=="drag"||op=="move"||op=="point","Unknown operation");
        const auto size=window->size(Desktop::View::IGeometric::GEOMETRIC_GOAL);
        Vector2D pos{num(j.get(),"x"),num(j.get(),"y")};
        auto valid=[&](Vector2D p){ return p.x>=0 && p.y>=0 && p.x<size.x && p.y<size.y; };
        require(valid(pos) || (!window->m_isX11 && bool(window->m_popupHead->at(window->position(Desktop::View::IGeometric::GEOMETRIC_GOAL)+pos,true))),"Point outside window and its popups");
        Vector2D end=pos;
        if(op=="drag") { end={num(j.get(),"end_x"),num(j.get(),"end_y")}; require(valid(end),"Drag endpoint outside window"); }
        int count=1; uint32_t button=272; double dx=0,dy=0;
        if(op=="click") { auto b=str(j.get(),"button"); require(b=="left"||b=="right"||b=="middle","Invalid button"); button=b=="right"?273:b=="middle"?274:272; auto n=num(j.get(),"count"); require(n>=1&&n<=3&&std::floor(n)==n,"Invalid click count"); count=n; }
        if(op=="scroll") {dx=num(j.get(),"dx");dy=num(j.get(),"dy");require(std::abs(dx)<=8388607&&std::abs(dy)<=8388607,"Scroll out of range");}
        auto hit=Desktop::viewState()->hitTest();
        auto origin=window->position(Desktop::View::IGeometric::GEOMETRIC_GOAL);
        Vector2D local=pos; auto surface=window->m_isX11?main:hit.windowSurfaceAt(origin+pos,window,local); require(bool(surface),"No input surface at point");
        // Drag coordinates remain relative to the initially pressed surface.
        auto endLocal=window->m_isX11?end:hit.surfaceLocalAt(origin+end,window,surface);
        require(!g_pSeatManager->m_seatGrab || g_pSeatManager->m_seatGrab->accepts(surface),"Unrelated seat grab active");
        if(op=="point")return R"({"ok":true})";
        auto previous=g_pSeatManager->m_state.pointerFocus.lock();
        Vector2D previousLocal;
        if(previous && previous->client()==seat->client()) {
            // A focused surface without global geometry (unmapped, or a popup of a
            // window that is not drawn) cannot be under the physical pointer; it
            // gets the pointer back at its origin, as Hyprland itself focuses one.
            auto wrapper=Desktop::View::CWLSurface::fromResource(previous);
            auto box=wrapper?wrapper->getSurfaceBoxGlobal():std::nullopt;
            if(box)previousLocal=Pointer::mgr()->position()-Vector2D{box->x,box->y};
        }
        std::vector<SP<CWLPointerResource>> resources;
        for(auto& weak:seat->m_pointers) if(auto p=weak.lock()) resources.push_back(p);
        require(!resources.empty(),"Application has no Wayland pointer resource");
        for(auto& p:resources) {
            auto t=now(); p->sendEnter(surface,local);
            // A user's pointer moves onto what it clicks; toolkits drop motion to
            // the position they last saw. Qt needs real motion after a press
            // whose release went to the menu it opened: without it, the next
            // right-click there sends its context menu to the window, not to
            // the widget under the pointer, and no menu opens.
            if(op=="click"){p->sendMotion(t,local+Vector2D{local.x>=1?-1.0:1.0,0.0});p->sendFrame();}
            p->sendMotion(t,local); p->sendFrame();
            if(op=="click") for(int i=0;i<count;++i) { p->sendButton(t+i*30,button,WL_POINTER_BUTTON_STATE_PRESSED); p->sendFrame(); p->sendButton(t+i*30+1,button,WL_POINTER_BUTTON_STATE_RELEASED); p->sendFrame(); }
            if(op=="drag") {
                p->sendButton(t,button,WL_POINTER_BUTTON_STATE_PRESSED); p->sendFrame();
                for(int i=1;i<=16;++i) {p->sendMotion(t+i,local+(endLocal-local)*(i/16.0));p->sendFrame();}
                p->sendButton(t+17,button,WL_POINTER_BUTTON_STATE_RELEASED);p->sendFrame();
            }
            if(op=="scroll") {
                p->sendAxisSource(WL_POINTER_AXIS_SOURCE_FINGER);
                if(dx) p->sendAxis(t,WL_POINTER_AXIS_HORIZONTAL_SCROLL,dx);
                if(dy) p->sendAxis(t,WL_POINTER_AXIS_VERTICAL_SCROLL,dy);
                p->sendFrame();
                if(dx) p->sendAxisStop(t+1,WL_POINTER_AXIS_HORIZONTAL_SCROLL);
                if(dy) p->sendAxisStop(t+1,WL_POINTER_AXIS_VERTICAL_SCROLL);
                p->sendFrame();
            }
            if(op!="move") p->sendLeave();
            if(previous && previous->client()==seat->client()) {p->sendEnter(previous,previousLocal);p->sendFrame();}
        }
        return R"({"ok":true})";
    } catch(const std::exception& e) {
        Json reply(json_object_new_object(),json_object_put);
        json_object_object_add(reply.get(),"ok",json_object_new_boolean(false));
        json_object_object_add(reply.get(),"error",json_object_new_string(e.what()));
        return json_object_to_json_string_ext(reply.get(),JSON_C_TO_STRING_PLAIN);
    }
}
}
APICALL EXPORT std::string PLUGIN_API_VERSION() { return HYPRLAND_API_VERSION; }
APICALL EXPORT PLUGIN_DESCRIPTION_INFO PLUGIN_INIT(HANDLE plugin) {
    require(std::string(__hyprland_api_get_hash())==__hyprland_api_get_client_hash(),"Hyprland headers do not match running compositor");
    require(bool(HyprlandAPI::registerHyprCtlCommand(plugin,SHyprCtlCommand{.name="codex-background",.exact=false,.fn=handle})),"Cannot register background command");
    Clipboard::setup(plugin);
    Capture::setup();
    Held::setup();
    Routing::setup();
    Drag::setup(plugin);
    Popups::setup(plugin);
    Activation::setup(plugin);
    Placement::setup(plugin);
    return {"codex-background","Window-targeted input without compositor focus or cursor movement","Codex Hyprland provider","0.1.0"};
}
APICALL EXPORT void PLUGIN_EXIT() { Placement::clear(); Capture::clear(); Activation::clear(); Popups::clear(); Drag::clear(); Held::clear(); Routing::clear(); Clipboard::clear(); }
