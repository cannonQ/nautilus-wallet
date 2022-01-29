import { createApp } from "vue";
import App from "./App.vue";
import router from "./router";
import store from "./store";
import VueFeather from "vue-feather";
import { wasmModule } from "./utils/wasm-module";
import PageTitle from "@/components/PageTitle.vue";
import ClickToCopy from "@/components/ClickToCopy.vue";
import ToolTip from "@/components/ToolTip.vue";
import DropDown from "@/components/DropDown.vue";
import LoadingModal from "@/components/LoadingModal.vue";
import LoadingIndicator from "@/components/LoadingIndicator.vue";
import WalletItem from "@/components/WalletItem.vue";
import axios from "axios";
import JSONBigInt from "json-bigint";
import { filters } from "@/utils/globalFilters";
import { Inputitems, Modal, Slider } from "@oruga-ui/oruga-next";
import { vueCleave } from "@/directives/cleave";
import { rpcHandler } from "@/background/rpcHandler";

import "@/assets/styles/fonts.css";
import "@oruga-ui/oruga-next/dist/oruga.css";
import "windi.css";
import "@/assets/styles/main.css";

rpcHandler.start();
wasmModule.loadAsync();

axios.defaults.transformResponse = [
  data => {
    if (typeof data === "string") {
      try {
        data = JSONBigInt.parse(data);
      } catch (e) {
        console.error(e);
        return data;
      }
    }
    return data;
  }
];

const app = createApp(App);
app.config.globalProperties.$filters = filters;

app
  .use(store)
  .use(router)
  .use(Inputitems)
  .use(Modal)
  .use(Slider)
  .directive("cleave", vueCleave)
  .component("vue-feather", VueFeather)
  .component("page-title", PageTitle)
  .component("click-to-copy", ClickToCopy)
  .component("tool-tip", ToolTip)
  .component("drop-down", DropDown)
  .component("loading-modal", LoadingModal)
  .component("loading-indicator", LoadingIndicator)
  .component("wallet-item", WalletItem)
  .mount("#app");
