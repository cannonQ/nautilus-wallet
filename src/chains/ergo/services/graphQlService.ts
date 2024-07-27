import { Address, Box, Header, Info, SignedTransaction, State, Token } from "@ergo-graphql/types";
import { Client, createClient, fetchExchange, gql, TypedDocumentNode } from "@urql/core";
import { retryExchange } from "@urql/exchange-retry";
import { hex, utf8 } from "@fleet-sdk/crypto";
import { SColl, SConstant, SPair } from "@fleet-sdk/serializer";
import { chunk, first, isEmpty } from "@fleet-sdk/common";
import { min } from "lodash-es";
import { browser, hasBrowserContext } from "@/common/browser";
import { sigmaDecode } from "@/chains/ergo/serialization";
import { ErgoBox, Registers } from "@/types/connector";
import { asDict } from "@/common/serializer";
import { CHUNK_DERIVE_LENGTH, ERG_TOKEN_ID, MAINNET } from "@/constants/ergo";
import { AssetStandard, AssetSubtype, AssetType } from "@/types/internal";
import { IAssetInfo } from "@/types/database";
import { bn } from "@/common/bigNumber";
import { log } from "@/common/logger";

export type AssetInfo = {
  tokenId: string;
  confirmedAmount: string;
  unconfirmedAmount?: string;
};

export type AddressInfo = {
  used: boolean;
  address: string;
  assets: AssetInfo[];
};

export type UnspentBoxesInfo = {
  oldest: number | undefined;
  count: number;
};

export const MIN_SERVER_VERSION = [0, 4, 4];
const MAX_RESULTS_PER_REQUEST = 50;
const MAX_PARAMS_PER_REQUEST = 20;

const GRAPHQL_SERVERS = MAINNET
  ? [
      "https://explore.sigmaspace.io/api/graphql",
      "https://gql.ergoplatform.com/",
      "https://graphql.erg.zelcore.io/"
    ]
  : ["https://gql-testnet.ergoplatform.com/"];

export function getDefaultServerUrl(): string {
  return GRAPHQL_SERVERS[0];
}

export function getRandomServerUrl(): string {
  return GRAPHQL_SERVERS[Math.floor(Math.random() * GRAPHQL_SERVERS.length)];
}

export async function getServerInfo(url: string): Promise<{ network: string; version: string }> {
  const client = createClient({ url, exchanges: [fetchExchange] });
  const query = gql<{ info: Info; state: State }>`
    query Info {
      info {
        version
      }
      state {
        network
      }
    }
  `;

  const response = await client.query(query, {}).toPromise();
  if (!response.data) {
    throw new Error(`No data returned from ${url}.`);
  }

  return {
    network: response.data.state.network,
    version: response.data.info.version
  };
}

export async function validateServerVersion(url: string): Promise<boolean> {
  try {
    const response = await getServerInfo(url);
    const [major, minor] = response.version.split(".");

    return (
      Number.parseInt(major, 10) === MIN_SERVER_VERSION[0] &&
      Number.parseInt(minor, 10) >= MIN_SERVER_VERSION[1]
    );
  } catch (e) {
    return false;
  }
}

export async function validateServerNetwork(url: string): Promise<boolean> {
  try {
    const response = await getServerInfo(url);

    return MAINNET ? response.network === "mainnet" : response.network === "testnet";
  } catch (e) {
    return false;
  }
}

class GraphQLService {
  #queryClient!: Client;
  #txBroadcastClient?: Client;
  #url!: string;

  constructor() {
    this.#loadServerUrl();
    this.#queryClient = this.#createQueryClient();
  }

  #createTxBroadcastClient(): Client {
    const defaultUrl = this.#url;

    return createClient({
      url: defaultUrl,
      requestPolicy: "network-only",
      exchanges: [
        retryExchange({
          initialDelayMs: 1000,
          maxDelayMs: 5000,
          randomDelay: true,
          maxNumberAttempts: 6,
          retryWith(error, operation) {
            const context = {
              ...operation.context,
              url:
                error.message && !error.message.match(/.*[iI]nput.*not found$/gm)
                  ? getRandomServerUrl()
                  : defaultUrl
            };
            return { ...operation, context };
          }
        }),
        fetchExchange
      ]
    });
  }

  #createQueryClient(): Client {
    return createClient({
      url: this.#url,
      requestPolicy: "network-only",
      exchanges: [
        retryExchange({
          initialDelayMs: 100,
          maxDelayMs: 5000,
          randomDelay: true,
          maxNumberAttempts: 3,
          retryWith(error, operation) {
            if (error.networkError) {
              const context = { ...operation.context, url: getRandomServerUrl() };
              return { ...operation, context };
            }

            return null;
          }
        }),
        fetchExchange
      ]
    });
  }

  #loadServerUrl() {
    if (hasBrowserContext()) {
      this.updateServerUrl(getDefaultServerUrl());
      browser?.storage.local.get("settings", (s) =>
        this.updateServerUrl(s.graphQLServer ?? getDefaultServerUrl())
      );

      return;
    }

    const rawSettings = localStorage.getItem("settings");
    if (!rawSettings) return;
    const url = JSON.parse(rawSettings).graphQLServer;
    this.updateServerUrl(url ?? getDefaultServerUrl());
  }

  #getTxBroadcastClient(): Client {
    if (!this.#txBroadcastClient) {
      this.#txBroadcastClient = this.#createTxBroadcastClient();
    }

    return this.#txBroadcastClient;
  }

  updateServerUrl(url: string) {
    if (this.#url === url) {
      return;
    }

    this.#url = url;
    this.#queryClient = this.#createQueryClient();
    this.#txBroadcastClient = undefined;
  }

  public async getAddressesInfo(addresses: string[]): Promise<AddressInfo[]> {
    const info = await this.#fetchAddressesInfo(addresses);
    return info?.map(addressInfoMapper) || [];
  }

  async #fetchAddressesInfo(addresses: string[]): Promise<Address[] | undefined> {
    const query = gql<{ addresses: Address[] }>`
      query Addresses($addresses: [String!]!) {
        addresses(addresses: $addresses) {
          address
          used
          balance {
            nanoErgs
            assets {
              amount
              tokenId
            }
          }
        }
      }
    `;

    const response = await this.#queryClient.query(query, { addresses }).toPromise();
    return response.data?.addresses;
  }

  public async getUsedAddresses(addresses: string[]): Promise<string[]> {
    if (CHUNK_DERIVE_LENGTH >= addresses.length) {
      return this.getUsedAddressesFromChunk(addresses);
    }

    const chunks = chunk(addresses, CHUNK_DERIVE_LENGTH);
    let used: string[] = [];
    for (const c of chunks) {
      used = used.concat(await this.getUsedAddressesFromChunk(c));
    }

    return used;
  }

  private async getUsedAddressesFromChunk(addresses: string[]): Promise<string[]> {
    const query = gql`
      query Addresses($addresses: [String!]!) {
        addresses(addresses: $addresses) {
          address
          used
        }
      }
    `;

    const response = await this.#queryClient
      .query<{ addresses: Address[] }>(query, { addresses })
      .toPromise();

    return response.data?.addresses.filter((x) => x.used).map((x) => x.address) || [];
  }

  async getCurrentHeight(): Promise<number | undefined> {
    const query = gql`
      query query {
        blockHeaders(take: 1) {
          height
        }
      }
    `;

    const response = await this.#queryClient
      .query<{ blockHeaders: Header[] }>(query, {})
      .toPromise();
    return response.data?.blockHeaders[0]?.height;
  }

  public async getUnspentBoxes(addresses: string[]): Promise<ErgoBox[]> {
    const query = gql`
      query Boxes($addresses: [String!], $skip: Int, $take: Int) {
        boxes(addresses: $addresses, skip: $skip, take: $take, spent: false) {
          boxId
          transactionId
          value
          creationHeight
          index
          ergoTree
          additionalRegisters
          assets {
            tokenId
            amount
          }
        }
      }
    `;

    let boxes: ErgoBox[] = [];
    const addressesChunks = chunk(addresses, MAX_PARAMS_PER_REQUEST);

    for (const addresses of addressesChunks) {
      boxes = boxes.concat(
        await this.queryAddressesChunkUnspentBoxes<ErgoBox>(addresses, query, (box) => {
          return {
            ...box,
            confirmed: true,
            additionalRegisters: box.additionalRegisters as Registers
          };
        })
      );
    }

    return boxes;
  }

  public async getUnspentBoxesInfo(addresses: string[]): Promise<UnspentBoxesInfo> {
    const query = gql`
      query BoxesCreationHeight($addresses: [String!], $skip: Int, $take: Int) {
        boxes(addresses: $addresses, skip: $skip, take: $take, spent: false) {
          creationHeight
        }
      }
    `;

    let heights: number[] = [];
    const addressesChunks = chunk(addresses, MAX_PARAMS_PER_REQUEST);

    for (const addresses of addressesChunks) {
      const chunk = await this.queryAddressesChunkUnspentBoxes(
        addresses,
        query,
        (box) => box.creationHeight
      );

      heights = heights.concat(chunk);
    }

    return { oldest: min(heights), count: heights.length };
  }

  public async getMempoolBoxes(address: string): Promise<ErgoBox[]> {
    const query = gql<{ mempool: { boxes: Box[] } }>`
      query MempoolBoxes($address: String!, $skip: Int, $take: Int) {
        mempool {
          boxes(address: $address, skip: $skip, take: $take) {
            boxId
            transactionId
            value
            creationHeight
            index
            ergoTree
            additionalRegisters
            assets {
              tokenId
              amount
            }
          }
        }
      }
    `;

    let boxes: Box[] = [];
    let lastChunkLength = 0;
    let skip = 0;

    do {
      const response = await this.#queryClient
        .query(query, { address, skip, take: MAX_RESULTS_PER_REQUEST })
        .toPromise();
      skip += MAX_RESULTS_PER_REQUEST;
      lastChunkLength = response.data?.mempool.boxes.length || 0;

      if (response.data && !isEmpty(response.data?.mempool.boxes)) {
        boxes = boxes.concat(response.data.mempool.boxes);
      }
    } while (lastChunkLength === MAX_RESULTS_PER_REQUEST);

    return (
      boxes.map((box) => {
        return {
          ...box,
          confirmed: false,
          additionalRegisters: box.additionalRegisters as Registers
        };
      }) || []
    );
  }

  private async queryAddressesChunkUnspentBoxes<T>(
    addresses: string[],
    query: TypedDocumentNode<{ boxes: Box[] }>,
    map: (box: Box) => T
  ): Promise<T[]> {
    let boxes: Box[] = [];
    let lastChunkLength = 0;
    let skip = 0;

    do {
      const response = await this.#queryClient
        .query(query, { addresses, skip, take: MAX_RESULTS_PER_REQUEST })
        .toPromise();
      skip += MAX_RESULTS_PER_REQUEST;
      lastChunkLength = response.data?.boxes.length || 0;

      if (response.data && !isEmpty(response.data?.boxes)) {
        boxes = boxes.concat(response.data.boxes);
      }
    } while (lastChunkLength === MAX_RESULTS_PER_REQUEST);

    return boxes.map(map) || [];
  }

  public async getTokenInfo(tokenId: string): Promise<Token | undefined> {
    // todo: add support for multiple tokens in one request
    const query = gql<{ tokens: Token[] }>`
      query Tokens($tokenId: String) {
        tokens(tokenId: $tokenId) {
          tokenId
          type
          emissionAmount
          name
          description
          decimals
          boxId
          box {
            transactionId
            additionalRegisters
          }
        }
      }
    `;

    const response = await this.#queryClient.query(query, { tokenId }).toPromise();
    return first(response.data?.tokens);
  }

  public async getAssetInfo(tokenId: string): Promise<IAssetInfo | undefined> {
    try {
      const tokenInfo = await this.getTokenInfo(tokenId);
      if (!tokenInfo) return;

      return parseEIP4Asset(tokenInfo);
    } catch {
      return;
    }
  }

  public async getAssetsInfo(tokenIds: string[]): Promise<IAssetInfo[] | undefined> {
    const info: (IAssetInfo | undefined)[] = [];

    try {
      for (const tokenId of tokenIds) {
        info.push(await this.getAssetInfo(tokenId));
      }

      return info.filter((assetInfo) => assetInfo) as IAssetInfo[];
    } catch (e) {
      log.error("Failed to fetch metadata", tokenIds, e);
    }

    return undefined;
  }

  public async getBlockHeaders(options: { take: number } = { take: 10 }): Promise<Header[]> {
    const query = gql<{ blockHeaders: Header[] }>`
      query Headers($take: Int) {
        blockHeaders(take: $take) {
          headerId
          parentId
          version
          height
          difficulty
          adProofsRoot
          stateRoot
          transactionsRoot
          timestamp
          nBits
          extensionHash
          powSolutions
          votes
        }
      }
    `;

    const response = await this.#queryClient.query(query, options).toPromise();
    return response.data?.blockHeaders ?? [];
  }

  public async checkTx(signedTx: SignedTransaction): Promise<string> {
    const query = gql<{ checkTransaction: string }>`
      mutation Mutation($signedTransaction: SignedTransaction!) {
        checkTransaction(signedTransaction: $signedTransaction)
      }
    `;

    const response = await this.#queryClient
      .mutation(query, { signedTransaction: signedTx })
      .toPromise();

    if (response.error) {
      throw Error(response.error.message);
    }

    return response.data?.checkTransaction || "";
  }

  public async sendTx(signedTx: SignedTransaction): Promise<string> {
    const query = gql<{ submitTransaction: string }>`
      mutation Mutation($signedTransaction: SignedTransaction!) {
        submitTransaction(signedTransaction: $signedTransaction)
      }
    `;

    const response = await this.#getTxBroadcastClient()
      .mutation(query, { signedTransaction: signedTx })
      .toPromise();

    if (response.error) {
      throw Error(response.error.message);
    }

    return response.data?.submitTransaction || "";
  }

  public async isTransactionInMempool(transactionId: string): Promise<boolean | undefined> {
    try {
      const query = gql<{ mempool: { transactions: { transactionId: string }[] } }>`
        query Mempool($transactionId: String) {
          mempool {
            transactions(transactionId: $transactionId) {
              transactionId
            }
          }
        }
      `;

      const response = await this.#getTxBroadcastClient()
        .query(query, { transactionId })
        .toPromise();

      if (response.error || !response.data) {
        return undefined;
      }

      return response.data.mempool.transactions.length > 0;
    } catch {
      return undefined;
    }
  }

  public async areTransactionsInMempool(
    txIds: string[]
  ): Promise<{ [txId: string]: boolean | undefined }> {
    return asDict(
      await Promise.all(
        txIds.map(async (txId) => ({
          [txId]: await this.isTransactionInMempool(txId)
        }))
      )
    );
  }
}

export const graphQLService = new GraphQLService();

function addressInfoMapper(gqlAddressInfo: Address): AddressInfo {
  const mapped: AddressInfo = {
    address: gqlAddressInfo.address,
    used: gqlAddressInfo.used,
    assets: gqlAddressInfo.balance.assets.map((t) => ({
      tokenId: t.tokenId,
      confirmedAmount: t.amount
    }))
  };

  if (bn(gqlAddressInfo.balance.nanoErgs).gt(0)) {
    mapped.assets.push({
      tokenId: ERG_TOKEN_ID,
      confirmedAmount: gqlAddressInfo.balance.nanoErgs?.toString() || "0"
    });
  }

  return mapped;
}

export function parseEIP4Asset(tokenInfo: Token): IAssetInfo | undefined {
  if (!tokenInfo.box) return;

  const registers = tokenInfo.box.additionalRegisters as Registers;
  const type = sigmaDecode<string>(registers.R7, hex);
  const assetInfo: IAssetInfo = {
    id: tokenInfo.tokenId,
    mintingBoxId: tokenInfo.boxId,
    mintingTransactionId: tokenInfo.box.transactionId,
    emissionAmount: tokenInfo.emissionAmount,
    name: tokenInfo.name ?? undefined,
    description: tokenInfo.description ?? undefined,
    decimals: tokenInfo.decimals ?? 0,
    type: parseType(type),
    subtype: parseSubtype(type),
    standard:
      tokenInfo.type === AssetStandard.EIP4 ? AssetStandard.EIP4 : AssetStandard.Unstandardized
  };

  if (assetInfo.type === AssetType.NFT) {
    assetInfo.artworkHash = sigmaDecode(registers.R8, hex);

    const r9 = SConstant.from<Uint8Array | [Uint8Array, Uint8Array]>(registers.R9);
    if (r9.type instanceof SColl) {
      assetInfo.artworkUrl = utf8.encode(r9.data as Uint8Array);
    } else if (r9.type instanceof SPair) {
      const [url, cover] = r9.data as [Uint8Array, Uint8Array];
      assetInfo.artworkUrl = url ? utf8.encode(url) : undefined;
      assetInfo.artworkCover = cover ? utf8.encode(cover) : undefined;
    }
  }

  return assetInfo;
}

function parseSubtype(r7Register?: string): AssetSubtype | undefined {
  if (!r7Register || isEmpty(r7Register)) return;
  return r7Register as AssetSubtype;
}

function parseType(r7Register?: string): AssetType {
  if (!r7Register || isEmpty(r7Register)) return AssetType.Unknown;

  if (r7Register.startsWith(AssetType.NFT)) {
    return AssetType.NFT;
  } else if (r7Register.startsWith(AssetType.MembershipToken)) {
    return AssetType.MembershipToken;
  }

  return AssetType.Unknown;
}
