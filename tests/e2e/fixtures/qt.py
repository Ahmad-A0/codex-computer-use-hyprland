"""Disposable Qt 6 app; Qt exposes AT-SPI only with its accessibility switch,
so this checks the provider's launch environment. Its line edit has Qt's
standard context menu and a button opens a QMenu (Qt announces open menus only
through AT-SPI events). Usage: qt.py STATE_JSON APP_ID"""
import json
import sys
from pathlib import Path
from PyQt6.QtWidgets import QApplication, QLineEdit, QMenu, QPushButton, QVBoxLayout, QWidget

out, app_id = Path(sys.argv[1]), sys.argv[2]
app = QApplication([sys.argv[0]])
app.setDesktopFileName(app_id)  # Wayland app_id
state = {'clicks': 0, 'text': '', 'selection': [], 'menu': None}
window = QWidget()
window.setWindowTitle('Codex E2E Qt')
layout = QVBoxLayout(window)
entry = QLineEdit()
entry.setAccessibleName('Qt entry')
button = QPushButton('Qt button')
menu_button = QPushButton('Qt menu button')
menu = QMenu(menu_button)
for name in ('first', 'second'):
    menu.addAction(f'Qt {name} choice').triggered.connect(lambda _=False, n=name: chosen(n))
menu_button.setMenu(menu)
layout.addWidget(entry)
layout.addWidget(button)
layout.addWidget(menu_button)


def save():
    out.write_text(json.dumps(state))


def changed(text):
    state['text'] = text
    save()


def selected():
    start = entry.selectionStart()
    state['selection'] = [start, start + len(entry.selectedText())] if start >= 0 else []
    save()


def clicked():
    state['clicks'] += 1
    save()


def chosen(name):
    state['menu'] = name
    save()


entry.textChanged.connect(changed)
entry.selectionChanged.connect(selected)
button.clicked.connect(clicked)
window.resize(480, 240)
window.show()
save()
app.exec()
