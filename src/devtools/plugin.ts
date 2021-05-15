import { setupDevtoolsPlugin, TimelineEvent } from '@vue/devtools-api'
import { App, ComponentPublicInstance } from 'vue'
import { PiniaPluginContext, setActivePinia } from '../rootStore'
import {
  Store,
  GettersTree,
  MutationType,
  StateTree,
  ActionsTree,
} from '../types'
import {
  formatDisplay,
  formatEventData,
  formatMutationType,
  formatStoreForInspectorState,
  formatStoreForInspectorTree,
} from './formatting'

/**
 * Registered stores used for devtools.
 */
const registeredStores = /*#__PURE__*/ new Map<string, Store>()

let isAlreadyInstalled: boolean | undefined
// timeline can be paused when directly changing the state
let isTimelineActive = true
const componentStateTypes: string[] = []

const MUTATIONS_LAYER_ID = 'pinia:mutations'
const INSPECTOR_ID = 'pinia'

export function addDevtools(app: App, store: Store) {
  // TODO: we probably need to ensure the latest version of the store is kept:
  // without effectScope, multiple stores will be created and will have a
  // limited lifespan for getters.
  let hasSubscribed = true
  if (!registeredStores.has(store.$id)) {
    registeredStores.set(store.$id, store)
    componentStateTypes.push('🍍 ' + store.$id)
    hasSubscribed = true
  }

  setupDevtoolsPlugin(
    {
      id: 'dev.esm.pinia',
      label: 'Pinia 🍍',
      logo: 'https://pinia.esm.dev/logo.svg',
      packageName: 'pinia',
      homepage: 'https://pinia.esm.dev',
      componentStateTypes,
      app,
    },
    (api) => {
      if (!isAlreadyInstalled) {
        api.addTimelineLayer({
          id: MUTATIONS_LAYER_ID,
          label: `Pinia 🍍`,
          color: 0xe5df88,
        })

        api.addInspector({
          id: INSPECTOR_ID,
          label: 'Pinia 🍍',
          icon: 'storage',
          treeFilterPlaceholder: 'Search stores',
        })

        api.on.inspectComponent((payload, ctx) => {
          if (
            (
              payload.componentInstance?.proxy as
                | ComponentPublicInstance
                | undefined
            )?._pStores
          ) {
            const piniaStores = (
              payload.componentInstance.proxy as ComponentPublicInstance
            )._pStores!

            Object.values(piniaStores).forEach((store) => {
              payload.instanceData.state.push({
                type: '🍍 ' + store.$id,
                key: 'state',
                editable: true,
                value: store.$state,
              })

              if (store._getters?.length) {
                payload.instanceData.state.push({
                  type: '🍍 ' + store.$id,
                  key: 'getters',
                  editable: false,
                  value: store._getters.reduce((getters, key) => {
                    // @ts-expect-error
                    getters[key] = store[key]
                    return getters
                  }, {} as GettersTree<StateTree>),
                })
              }
            })
          }
        })

        api.on.getInspectorTree((payload) => {
          if (payload.app === app && payload.inspectorId === INSPECTOR_ID) {
            const stores = Array.from(registeredStores.values())

            payload.rootNodes = (
              payload.filter
                ? stores.filter((store) =>
                    store.$id
                      .toLowerCase()
                      .includes(payload.filter.toLowerCase())
                  )
                : stores
            ).map(formatStoreForInspectorTree)
          }
        })

        api.on.getInspectorState((payload) => {
          if (payload.app === app && payload.inspectorId === INSPECTOR_ID) {
            const store = registeredStores.get(payload.nodeId)

            if (!store) {
              return toastMessage(
                `store "${payload.nodeId}" not found`,
                'error'
              )
            }

            if (store) {
              payload.state = {
                options: formatStoreForInspectorState(store),
              }
            }
          }
        })

        api.on.editInspectorState((payload) => {
          if (payload.app === app && payload.inspectorId === INSPECTOR_ID) {
            const store = registeredStores.get(payload.nodeId)

            if (!store) {
              return toastMessage(
                `store "${payload.nodeId}" not found`,
                'error'
              )
            }

            const { path } = payload
            if (path[0] !== 'state') {
              return toastMessage(
                `Invalid path for store "${payload.nodeId}":\n${path}\nOnly state can be modified.`
              )
            }

            // rewrite the first entry to be able to directly set the state as
            // well as any other path
            path[0] = '$state'
            isTimelineActive = false
            payload.set(store, path, payload.state.value)
            isTimelineActive = true
          }
        })

        api.on.editComponentState((payload) => {
          if (payload.type.startsWith('🍍')) {
            const storeId = payload.type.replace(/^🍍\s*/, '')
            const store = registeredStores.get(storeId)

            if (!store) {
              return toastMessage(`store "${storeId}" not found`, 'error')
            }

            const { path } = payload
            if (path[0] !== 'state') {
              return toastMessage(
                `Invalid path for store "${storeId}":\n${path}\nOnly state can be modified.`
              )
            }

            // rewrite the first entry to be able to directly set the state as
            // well as any other path
            path[0] = '$state'
            isTimelineActive = false
            payload.set(store, path, payload.state.value)
            isTimelineActive = true
          }
        })

        isAlreadyInstalled = true
      } else {
        api.sendInspectorTree(INSPECTOR_ID)
        api.sendInspectorState(INSPECTOR_ID)
      }

      // avoid subscribing to mutations and actions twice
      if (hasSubscribed) return

      store.$onAction(({ after, onError, name, args, store }) => {
        const groupId = runningActionId++

        api.addTimelineEvent({
          layerId: MUTATIONS_LAYER_ID,
          event: {
            time: Date.now(),
            title: '🛫 ' + name,
            subtitle: 'start',
            data: {
              action: formatDisplay(name),
              args,
            },
            groupId,
          },
        })

        after((result) => {
          api.addTimelineEvent({
            layerId: MUTATIONS_LAYER_ID,
            event: {
              time: Date.now(),
              title: '🛬 ' + name,
              subtitle: 'end',
              data: {
                action: formatDisplay(name),
                args,
                result,
              },
              groupId,
            },
          })
        })

        onError((error) => {
          api.addTimelineEvent({
            layerId: MUTATIONS_LAYER_ID,
            event: {
              time: Date.now(),
              logType: 'error',
              title: '💥 ' + name,
              subtitle: 'end',
              data: {
                action: formatDisplay(name),
                args,
                error,
              },
              groupId,
            },
          })
        })
      })

      store.$subscribe(({ events, type }, state) => {
        if (!isTimelineActive) return
        // rootStore.state[store.id] = state

        api.notifyComponentUpdate()
        api.sendInspectorState(INSPECTOR_ID)

        const eventData: TimelineEvent = {
          time: Date.now(),
          title: formatMutationType(type),
          data: formatEventData(events),
          groupId: activeAction,
        }

        // reset for the next mutation
        activeAction = undefined

        if (type === MutationType.patchFunction) {
          eventData.subtitle = '⤵️'
        } else if (type === MutationType.patchObject) {
          eventData.subtitle = '🧩'
        } else if (events && !Array.isArray(events)) {
          eventData.subtitle = events.type
        }

        if (events) {
          eventData.data['rawEvent(s)'] = {
            _custom: {
              display: 'DebuggerEvent',
              type: 'object',
              tooltip: 'raw DebuggerEvent[]',
              value: events,
            },
          }
        }

        api.addTimelineEvent({
          layerId: MUTATIONS_LAYER_ID,
          event: eventData,
        })
      })

      // trigger an update so it can display new registered stores
      // @ts-ignore
      api.notifyComponentUpdate()
      toastMessage(`"${store.$id}" store installed`)
    }
  )
}

let runningActionId = 0
let activeAction: number | undefined

/**
 * pinia.use(devtoolsPlugin)
 */
export function devtoolsPlugin<
  Id extends string = string,
  S extends StateTree = StateTree,
  G extends GettersTree<S> = GettersTree<S>,
  A /* extends ActionsTree */ = ActionsTree
>({ app, store, options, pinia }: PiniaPluginContext<Id, S, G, A>) {
  const wrappedActions = {} as A

  // original actions of the store as they are given by pinia. We are going to override them
  const actions = Object.keys(options.actions || ({} as A)).reduce(
    (storeActions, actionName) => {
      // @ts-expect-error
      storeActions[actionName] = store[actionName]
      return storeActions
    },
    {} as ActionsTree
  )

  for (const actionName in actions) {
    // @ts-expect-error
    wrappedActions[actionName] = function () {
      setActivePinia(pinia)
      // the running action id is incremented in a before action hook
      const _actionId = runningActionId
      const trackedStore = new Proxy(store, {
        get(...args) {
          activeAction = _actionId
          return Reflect.get(...args)
        },
        set(...args) {
          activeAction = _actionId
          return Reflect.set(...args)
        },
      })
      return actions[actionName].apply(
        trackedStore,
        arguments as unknown as any[]
      )
    }
  }

  addDevtools(
    app,
    // @ts-expect-error: FIXME: if possible...
    store
  )

  return { ...wrappedActions }
}

/**
 * Shows a toast or console.log
 *
 * @param message - message to log
 * @param type - different color of the tooltip
 */
function toastMessage(
  message: string,
  type?: 'normal' | 'error' | 'warning' | undefined
) {
  const piniaMessage = '🍍 ' + message

  if (typeof __VUE_DEVTOOLS_TOAST__ === 'function') {
    __VUE_DEVTOOLS_TOAST__(piniaMessage, type)
  } else if (type === 'error') {
    console.error(piniaMessage)
  } else if (type === 'warning') {
    console.warn(piniaMessage)
  } else {
    console.log(piniaMessage)
  }
}
