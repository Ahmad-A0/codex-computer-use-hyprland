"""Disposable native X11 drag source and destination."""
import sys,json
from pathlib import Path
import gi
gi.require_version('Gtk','3.0')
from gi.repository import Gtk,Gdk,GLib
GLib.set_prgname('codex-xdrag-fixture')
windows=[]
events=[]
def log(*args):
    events.append(str(args[1:]));Path(sys.argv[1]+'.events').write_text(json.dumps(events))
for name in ['source','destination']:
    w=Gtk.Window(title='X11 drag '+name);w.set_default_size(400,300)
    label=Gtk.EventBox();label.add(Gtk.Label(label='Drag '+name));w.add(label)
    targets=[Gtk.TargetEntry.new('text/plain;charset=utf-8',0,0)]
    if name=='source':
        label.connect('drag-begin',log);label.connect('drag-end',log);label.connect('drag-failed',log)
        label.drag_source_set(Gdk.ModifierType.BUTTON1_MASK,targets,Gdk.DragAction.COPY)
        label.connect('drag-data-get',lambda widget,context,selection,info,t:selection.set(selection.get_target(),8,'X11 native drag ✓'.encode()))
    else:
        label.drag_dest_set(Gtk.DestDefaults.ALL,targets,Gdk.DragAction.COPY)
        def receive(widget,context,x,y,selection,info,t):
            Path(sys.argv[1]).write_text(json.dumps({'text':bytes(selection.get_data()).decode()}))
            Gtk.drag_finish(context,True,False,t)
        label.connect('drag-data-received',receive)
    w.show_all();windows.append(w)
Gtk.main()
