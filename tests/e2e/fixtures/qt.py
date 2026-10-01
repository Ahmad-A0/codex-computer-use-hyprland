"""Disposable Qt 6 app; Qt exposes AT-SPI only with its accessibility switch,
so this checks the provider's launch environment. Usage: qt.py STATE_JSON APP_ID"""
import json
import sys
from pathlib import Path
from PyQt6.QtWidgets import QApplication, QLineEdit, QPushButton, QVBoxLayout, QWidget

out, app_id = Path(sys.argv[1]), sys.argv[2]
app = QApplication([sys.argv[0]])
app.setDesktopFileName(app_id)  # Wayland app_id
state = {'clicks': 0, 'text': ''}
window = QWidget()
window.setWindowTitle('Codex E2E Qt')
layout = QVBoxLayout(window)
entry = QLineEdit()
entry.setAccessibleName('Qt entry')
button = QPushButton('Qt button')
layout.addWidget(entry)
layout.addWidget(button)


def save():
    out.write_text(json.dumps(state))


def changed(text):
    state['text'] = text
    save()


def clicked():
    state['clicks'] += 1
    save()


entry.textChanged.connect(changed)
button.clicked.connect(clicked)
window.resize(480, 200)
window.show()
save()
app.exec()
