#include <X11/extensions/Xcomposite.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>
struct XPopup {Window window;int x,y,width,height;bool menu=false;};
static std::vector<XPopup> ownedPopups(Display* d,Window target){
 Window root,parent,*children=nullptr;unsigned count=0;std::vector<XPopup> result;
 if(!XQueryTree(d,DefaultRootWindow(d),&root,&parent,&children,&count))return result;
 for(unsigned i=0;i<count;++i){auto w=children[i];if(w==target)continue;XWindowAttributes a;if(!XGetWindowAttributes(d,w,&a)||a.map_state!=IsViewable||!a.override_redirect)continue;
  // A popup belongs to the nearest managed window in its transient chain: a
  // dialog's menu is the dialog's, although the dialog is transient for target.
  Window ancestor=w;bool owned=false;for(int depth=0;depth<32;++depth){Window next;if(!XGetTransientForHint(d,ancestor,&next)||!next||next==ancestor)break;if(next==target){owned=true;break;}XWindowAttributes between;if(!XGetWindowAttributes(d,next,&between)||!between.override_redirect)break;ancestor=next;}
  if(!owned)continue;
  int x,y;Window child;if(XTranslateCoordinates(d,w,target,0,0,&x,&y,&child)){
   bool menu=false;Atom type;int format;unsigned long n,left;unsigned char* data=nullptr;
   XGetWindowProperty(d,w,XInternAtom(d,"_NET_WM_WINDOW_TYPE",False),0,32,False,XA_ATOM,&type,&format,&n,&left,&data);
   if(data){if(format==32)for(unsigned long j=0;j<n;++j)for(auto name:{"_NET_WM_WINDOW_TYPE_MENU","_NET_WM_WINDOW_TYPE_POPUP_MENU","_NET_WM_WINDOW_TYPE_DROPDOWN_MENU","_NET_WM_WINDOW_TYPE_COMBO"})if(reinterpret_cast<unsigned long*>(data)[j]==XInternAtom(d,name,False))menu=true;XFree(data);}
   result.push_back({w,x,y,a.width,a.height,menu});
  }
 }
 if(children)XFree(children);
 return result;
}
static std::string capturePopups(Display* d,Window target,const XWindowAttributes& parent,json_object* request){
 auto path=str(request,"path");auto runtime=getenv("XDG_RUNTIME_DIR");need(runtime&&path.starts_with(std::string(runtime)+"/codex-cua-popup-"),"Invalid capture path");
 int fd=open(path.c_str(),O_WRONLY|O_CLOEXEC|O_NOFOLLOW);struct stat st{};need(fd>=0&&fstat(fd,&st)==0&&S_ISREG(st.st_mode)&&st.st_uid==getuid()&&!(st.st_mode&077),"Invalid capture file");
 struct File{int fd;~File(){close(fd);}} file{fd};
 auto* reply=json_object_new_object();json_object_object_add(reply,"ok",json_object_new_boolean(true));auto* list=json_object_new_array();json_object_object_add(reply,"popups",list);size_t offset=0;
 double scale=parent.width/num(request,"width");
 for(auto p:ownedPopups(d,target)){
  need(p.width>0&&p.height>0&&uint64_t(p.width)*p.height<=16777216,"Popup capture exceeds limit");
  Pixmap pixmap=XCompositeNameWindowPixmap(d,p.window);need(pixmap,"Cannot acquire popup pixmap");
  XImage* image=XGetImage(d,pixmap,0,0,p.width,p.height,AllPlanes,ZPixmap);XFreePixmap(d,pixmap);need(image,"Cannot read popup pixmap");
  XWindowAttributes popupAttributes;need(XGetWindowAttributes(d,p.window,&popupAttributes),"Popup disappeared during capture");
  if(!image->red_mask){image->red_mask=popupAttributes.visual->red_mask;image->green_mask=popupAttributes.visual->green_mask;image->blue_mask=popupAttributes.visual->blue_mask;}
  std::vector<unsigned char> bytes(size_t(p.width)*p.height*4);
  auto component=[](unsigned long pixel,unsigned long mask){if(!mask)return 0ul;while(!(mask&1)){mask>>=1;pixel>>=1;}return (pixel&mask)*255/mask;};
  for(int y=0;y<p.height;++y)for(int x=0;x<p.width;++x){auto pixel=XGetPixel(image,x,y);auto i=(size_t(y)*p.width+x)*4;bytes[i]=component(pixel,image->red_mask);bytes[i+1]=component(pixel,image->green_mask);bytes[i+2]=component(pixel,image->blue_mask);bytes[i+3]=image->depth==32?(pixel>>24)&255:255;}
  XDestroyImage(image);need(offset+bytes.size()<=128*1024*1024,"Popup capture exceeds total limit");
  for(size_t n=0;n<bytes.size();){auto amount=write(fd,bytes.data()+n,bytes.size()-n);if(amount<0&&errno==EINTR)continue;need(amount>0,"Cannot write popup capture");n+=amount;}
  auto* item=json_object_new_object();auto number=[&](const char* key,double value){json_object_object_add(item,key,json_object_new_double(value));};
  number("offset",offset);number("bytes",bytes.size());number("width",p.width);number("height",p.height);number("scale",scale);number("transform",0);number("crop_x",0);number("crop_y",0);number("x",p.x/scale);number("y",p.y/scale);number("w",p.width/scale);number("h",p.height/scale);json_object_array_add(list,item);offset+=bytes.size();
 }
 std::string output=json_object_to_json_string_ext(reply,JSON_C_TO_STRING_PLAIN);json_object_put(reply);return output;
}
// Owned popup geometry relative to the target (logical units) and in X pixels.
static std::string listPopups(Display* d,Window target,const XWindowAttributes& parent,json_object* request){
 double scale=parent.width/num(request,"width");
 auto* reply=json_object_new_object();json_object_object_add(reply,"ok",json_object_new_boolean(true));auto* list=json_object_new_array();json_object_object_add(reply,"popups",list);
 for(auto p:ownedPopups(d,target)){
  auto* item=json_object_new_object();auto number=[&](const char* key,double value){json_object_object_add(item,key,json_object_new_double(value));};
  number("x",p.x/scale);number("y",p.y/scale);number("w",p.width/scale);number("h",p.height/scale);number("raw_w",p.width);number("raw_h",p.height);number("scale",scale);json_object_array_add(list,item);
 }
 std::string output=json_object_to_json_string_ext(reply,JSON_C_TO_STRING_PLAIN);json_object_put(reply);return output;
}
