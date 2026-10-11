"""Disposable Qt 6 app of item views and controls for tests/e2e/cases/widgets.mjs.
Tab "Items": an expandable QTreeWidget and an editable 40-row QTableWidget in a
short viewport above a "Trap" button. Tab "Settings": a combo box, check box, radio group, spin box,
slider, progress bar, and disabled and hidden buttons. Its state is written to
a JSON file so tests check the app itself. Usage: widgets_qt.py STATE_JSON APP_ID"""
import json
import sys
from pathlib import Path
from PyQt6.QtWidgets import (QApplication, QButtonGroup, QCheckBox, QComboBox, QProgressBar, QPushButton,
                             QRadioButton, QSlider, QSpinBox, QTableWidget, QTableWidgetItem, QTabWidget,
                             QTreeWidget, QTreeWidgetItem, QVBoxLayout, QWidget)
from PyQt6.QtCore import Qt, QTimer

out, app_id = Path(sys.argv[1]), sys.argv[2]
app = QApplication([sys.argv[0]])
app.setDesktopFileName(app_id)  # Wayland app_id
state = {'tab': 0, 'trap': 0, 'expanded': [], 'treeSelected': None, 'treeActivated': None, 'cell': None, 'prices': {},
         'disabledClicks': 0, 'hiddenClicks': 0, 'revealed': False}
window = QWidget()
window.setWindowTitle('Codex E2E Widgets Qt')
tabs = QTabWidget()
QVBoxLayout(window).addWidget(tabs)

items = QWidget()
items_layout = QVBoxLayout(items)
departments = QTreeWidget()
departments.setAccessibleName('Departments')
departments.setHeaderLabels(['Name'])


def add(parent, name, children=()):
    node = QTreeWidgetItem(parent, [name])
    for child in children:
        add(node, *child)


for entry in (('Engineering', (('Backend', (('Alice',), ('Bob',))), ('Frontend', (('Dana',),)))),
              ('Sales', (('Carol',),)), ('Support',)):
    add(departments, *entry)
prices = QTableWidget(40, 2)
prices.setAccessibleName('Prices')
prices.setHorizontalHeaderLabels(['Product', 'Price'])
for row in range(40):
    prices.setItem(row, 0, QTableWidgetItem(f'Product {row:02d}'))
    prices.setItem(row, 1, QTableWidgetItem(str(row * 10)))
prices.setFixedHeight(200)
# Rows scrolled out of the table lie over this button.
trap = QPushButton('Trap')
trap.setFixedHeight(150)
items_layout.setSpacing(0)
items_layout.addWidget(departments)
items_layout.addWidget(prices)
items_layout.addWidget(trap)
tabs.addTab(items, 'Items')

settings = QWidget()
settings_layout = QVBoxLayout(settings)
theme = QComboBox()
theme.setAccessibleName('Theme')
theme.addItems(['Light', 'Dark', 'Solarized', 'High contrast'])
autosave = QCheckBox('Autosave')
schedule = QButtonGroup(settings)
radios = [QRadioButton(name) for name in ('Daily', 'Weekly', 'Monthly')]
radios[0].setChecked(True)
for radio in radios:
    schedule.addButton(radio)
retries = QSpinBox()
retries.setAccessibleName('Retries')
retries.setRange(0, 10)
retries.setValue(3)
zoom = QSlider(Qt.Orientation.Horizontal)
zoom.setAccessibleName('Zoom')
zoom.setRange(50, 200)
zoom.setValue(100)
indexing = QProgressBar()
indexing.setAccessibleName('Indexing')
indexing.setValue(40)
disabled = QPushButton('Disabled action')
disabled.setEnabled(False)
hidden = QPushButton('Hidden action')
hidden.setVisible(False)
reveal = QPushButton('Reveal')
for widget in (theme, autosave, *radios, retries, zoom, indexing, disabled, hidden, reveal):
    settings_layout.addWidget(widget)
tabs.addTab(settings, 'Settings')


def path_names(item):
    names = []
    while item is not None:
        names.insert(0, item.text(0))
        item = item.parent()
    return '/'.join(names)


def expanded():
    found = []

    def walk(item):
        if item.isExpanded():
            found.append(item.text(0))
        for i in range(item.childCount()):
            walk(item.child(i))
    for i in range(departments.topLevelItemCount()):
        walk(departments.topLevelItem(i))
    return found


def over_trap():
    """Products whose row centre lies over the Trap button (outside the table's viewport)."""
    top = trap.mapTo(window, trap.rect().topLeft()).y()
    over = []
    for row in range(prices.rowCount()):
        rect = prices.visualItemRect(prices.item(row, 0))
        y = prices.viewport().mapTo(window, rect.center()).y()
        if top < y < top + trap.height():
            over.append(prices.item(row, 0).text())
    return over


def save(*_):
    current = departments.currentItem()
    state.update(tab=tabs.currentIndex(), expanded=expanded(), treeSelected=path_names(current) if current else None,
                 cell=[prices.currentRow(), prices.currentColumn()], theme=theme.currentText(),
                 autosave=autosave.isChecked(), autosaveEnabled=autosave.isEnabled(),
                 schedule=next((r.text() for r in radios if r.isChecked()), None), retries=retries.value(),
                 zoom=zoom.value(), tableScroll=prices.verticalScrollBar().value(),
                 tableRows=[prices.rowAt(0), prices.rowAt(prices.viewport().height() - 1)], overTrap=over_trap())
    out.write_text(json.dumps(state))


def count(key):
    def handler(*_):
        state[key] += 1
        save()
    return handler


def activated(item, _column):
    state['treeActivated'] = path_names(item)
    save()


def changed(item):
    if item.column() == 1:
        state['prices'][prices.item(item.row(), 0).text()] = item.text()
    save()


def revealed():
    hidden.setVisible(True)
    autosave.setEnabled(False)
    state['revealed'] = True
    save()


departments.itemExpanded.connect(save)
departments.itemCollapsed.connect(save)
departments.currentItemChanged.connect(save)
departments.itemActivated.connect(activated)
prices.itemChanged.connect(changed)
prices.currentCellChanged.connect(save)
prices.verticalScrollBar().valueChanged.connect(save)
tabs.currentChanged.connect(save)
theme.currentTextChanged.connect(save)
autosave.toggled.connect(save)
for radio in radios:
    radio.toggled.connect(save)
retries.valueChanged.connect(save)
zoom.valueChanged.connect(save)
trap.clicked.connect(count('trap'))
disabled.clicked.connect(count('disabledClicks'))
hidden.clicked.connect(count('hiddenClicks'))
reveal.clicked.connect(revealed)
from PyQt6.QtCore import QEvent, QObject  # noqa: E402


class Wheels(QObject):
    """TEMPORARY: record wheel events Qt delivers, for the scroll probe."""
    def eventFilter(self, obj, event):
        if event.type() == QEvent.Type.Wheel:
            state.setdefault('wheels', []).append([type(obj).__name__, str(event.phase()), event.angleDelta().y(),
                                                   event.pixelDelta().y(), event.isAccepted()])
            state['wheels'] = state['wheels'][-12:]
            state['popup'] = str(QApplication.activePopupWidget())
            save()
        return False


wheels = Wheels()
app.installEventFilter(wheels)
window.resize(520, 720)
window.show()
save()
QTimer.singleShot(500, save)  # once laid out
app.exec()
