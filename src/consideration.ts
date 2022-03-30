import { providers as multicallProviders } from "@0xsequence/multicall";
import { BigNumberish, Contract, ethers, providers } from "ethers";
import { ConsiderationABI } from "./abi/Consideration";
import {
  CONSIDERATION_CONTRACT_NAME,
  CONSIDERATION_CONTRACT_VERSION,
  EIP_712_ORDER_TYPE,
  MAX_INT,
  ProxyStrategy,
} from "./constants";
import type { Consideration as ConsiderationContract } from "./typechain/Consideration";
import type {
  ConsiderationConfig,
  CreatedOrder,
  CreateOrderAction,
  CreateOrderInput,
  ExchangeAction,
  Order,
  OrderComponents,
  OrderParameters,
  OrderUseCase,
} from "./types";
import { getApprovalActions } from "./utils/approval";
import {
  getBalancesAndApprovals,
  getInsufficientBalanceAndApprovalAmounts,
} from "./utils/balancesAndApprovals";
import {
  fulfillBasicOrder,
  fulfillStandardOrder,
  shouldUseBasicFulfill,
} from "./utils/fulfill";
import {
  getSummedTokenAndIdentifierAmounts,
  isCurrencyItem,
} from "./utils/item";
import {
  deductFees,
  feeToConsiderationItem,
  generateRandomSalt,
  getNonce,
  getOrderHash,
  getOrderStatus,
  mapInputItemToOfferItem,
  ORDER_OPTIONS_TO_ORDER_TYPE,
  totalItemsAmount,
  useProxyFromApprovals,
  validateOrderParameters,
} from "./utils/order";
import { getProxy } from "./utils/proxy";
import { executeAllActions } from "./utils/usecase";

export class Consideration {
  // Provides the raw interface to the contract for flexibility
  public contract: ConsiderationContract;

  private provider: providers.JsonRpcProvider;

  // Use the multicall provider for reads for batching and performance optimisations
  // NOTE: Do NOT await between sequential requests if you're intending to batch
  // instead, use Promise.all() and map to fetch data in parallel
  // https://www.npmjs.com/package/@0xsequence/multicall
  private multicallProvider: multicallProviders.MulticallProvider;

  private config: Required<Omit<ConsiderationConfig, "overrides">>;
  private legacyProxyRegistryAddress: string;

  public constructor(
    provider: providers.JsonRpcProvider,
    {
      overrides,
      ascendingAmountFulfillmentBuffer = 1800,
      approveExactAmount = false,
      balanceAndApprovalChecksOnOrderCreation = true,
      balanceAndApprovalChecksOnOrderFulfillment = true,
      proxyStrategy = ProxyStrategy.IF_ZERO_APPROVALS_NEEDED,
    }: ConsiderationConfig
  ) {
    this.provider = provider;
    this.multicallProvider = new multicallProviders.MulticallProvider(provider);

    this.contract = new Contract(
      overrides?.contractAddress ?? "",
      ConsiderationABI,
      provider.getSigner()
    ) as ConsiderationContract;

    this.config = {
      ascendingAmountFulfillmentBuffer,
      approveExactAmount,
      balanceAndApprovalChecksOnOrderCreation,
      balanceAndApprovalChecksOnOrderFulfillment,
      proxyStrategy,
    };

    this.legacyProxyRegistryAddress =
      overrides?.legacyProxyRegistryAddress ?? "";
  }

  private _getOrderTypeFromOrderOptions({
    allowPartialFills,
    restrictedByZone,
    useProxy,
  }: Pick<
    CreateOrderInput,
    "allowPartialFills" | "restrictedByZone" | "useProxy"
  >) {
    const fillsKey = allowPartialFills ? "PARTIAL" : "FULL";
    const restrictedKey = restrictedByZone ? "RESTRICTED" : "OPEN";
    const proxyKey = useProxy ? "VIA_PROXY" : "WITHOUT_PROXY";

    const orderType =
      ORDER_OPTIONS_TO_ORDER_TYPE[fillsKey][restrictedKey][proxyKey];

    return orderType;
  }

  public async createOrder(
    {
      zone = ethers.constants.AddressZero,
      // Default to current unix time.
      startTime = Math.floor(Date.now() / 1000).toString(),
      // Defaulting to "never end". We HIGHLY recommend passing in an explicit end time
      endTime = MAX_INT.toString(),
      offer,
      consideration,
      nonce,
      allowPartialFills,
      restrictedByZone,
      fees,
      salt = generateRandomSalt(),
    }: CreateOrderInput,
    accountAddress?: string
  ): Promise<OrderUseCase<CreateOrderAction>> {
    const signer = await this.provider.getSigner(accountAddress);
    const offerer = await signer.getAddress();
    const offerItems = offer.map(mapInputItemToOfferItem);
    const considerationItems = [
      ...consideration.map((consideration) => ({
        ...mapInputItemToOfferItem(consideration),
        recipient: consideration.recipient ?? offerer,
      })),
    ];

    const currencies = [...offerItems, ...considerationItems].filter(
      isCurrencyItem
    );

    const totalCurrencyAmount = totalItemsAmount(currencies);

    const [proxy, resolvedNonce] = await Promise.all([
      getProxy(offerer, {
        legacyProxyRegistryAddress: this.legacyProxyRegistryAddress,
        multicallProvider: this.multicallProvider,
      }),
      nonce ??
        getNonce(
          { offerer, zone },
          {
            considerationContract: this.contract,
            multicallProvider: this.multicallProvider,
          }
        ),
    ]);

    const balancesAndApprovals = await getBalancesAndApprovals(
      offerer,
      offerItems,
      {
        proxy,
        considerationContract: this.contract,
        multicallProvider: this.multicallProvider,
      }
    );

    const { insufficientOwnerApprovals, insufficientProxyApprovals } =
      getInsufficientBalanceAndApprovalAmounts(
        balancesAndApprovals,
        getSummedTokenAndIdentifierAmounts(offerItems),
        {
          considerationContract: this.contract,
          proxy,
          proxyStrategy: this.config.proxyStrategy,
        }
      );

    const useProxy = useProxyFromApprovals({
      insufficientOwnerApprovals,
      insufficientProxyApprovals,
      proxyStrategy: this.config.proxyStrategy,
    });

    const orderType = this._getOrderTypeFromOrderOptions({
      allowPartialFills,
      restrictedByZone,
      useProxy,
    });

    const orderParameters: OrderParameters = {
      offerer,
      zone,
      startTime,
      endTime,
      orderType,
      offer: offerItems,
      consideration: considerationItems,
      salt,
    };

    const checkBalancesAndApprovals =
      this.config.balanceAndApprovalChecksOnOrderCreation;

    const insufficientApprovals = validateOrderParameters(orderParameters, {
      balancesAndApprovals,
      throwOnInsufficientBalances: checkBalancesAndApprovals,
      considerationContract: this.contract,
      proxy,
      proxyStrategy: this.config.proxyStrategy,
    });

    // Construct the order such that fees are deducted from the original offer and consideration amounts
    const orderParametersWithDeductedFees = {
      ...orderParameters,
      offer: deductFees(offerItems, fees),
      consideration: [
        ...deductFees(considerationItems, fees),
        ...(fees?.map((fee) =>
          feeToConsiderationItem({
            fee,
            token: currencies[0].token,
            baseAmount: totalCurrencyAmount.startAmount,
            baseEndAmount: totalCurrencyAmount.endAmount,
          })
        ) ?? []),
      ],
    };

    const signOrder = this.signOrder.bind(this);

    const approvalActions = checkBalancesAndApprovals
      ? await getApprovalActions(insufficientApprovals, {
          signer,
        })
      : [];

    const createOrderAction = {
      type: "create",
      createOrder: async () => {
        const signature = await signOrder(
          orderParametersWithDeductedFees,
          resolvedNonce,
          accountAddress
        );

        return {
          parameters: orderParametersWithDeductedFees,
          nonce: resolvedNonce,
          signature,
        };
      },
    } as const;

    const actions = [...approvalActions, createOrderAction] as const;

    return {
      actions,
      executeAllActions: () =>
        executeAllActions(actions) as Promise<CreatedOrder>,
    };
  }

  public async signOrder(
    orderParameters: OrderParameters,
    nonce: number,
    accountAddress?: string
  ) {
    const signer = this.provider.getSigner(accountAddress);
    const { chainId } = await this.provider.getNetwork();

    const domainData = {
      name: CONSIDERATION_CONTRACT_NAME,
      version: CONSIDERATION_CONTRACT_VERSION,
      chainId,
      verifyingContract: this.contract.address,
    };

    const orderComponents: OrderComponents = {
      ...orderParameters,
      nonce,
    };

    const signature = await signer._signTypedData(
      domainData,
      EIP_712_ORDER_TYPE,
      orderComponents
    );

    // Use EIP-2098 compact signatures to save gas. https://eips.ethereum.org/EIPS/eip-2098
    return ethers.utils.splitSignature(signature).compact;
  }

  public async cancelOrders(
    orders: OrderComponents[],
    accountAddress?: string
  ) {
    const signer = this.provider.getSigner(accountAddress);
    return this.contract.connect(signer).cancel(orders);
  }

  public async bulkCancelOrders({
    offerer,
    zone = ethers.constants.AddressZero,
  }: {
    offerer?: string;
    zone: string;
  }) {
    const signer = this.provider.getSigner(offerer);
    const resolvedOfferer = offerer ?? (await signer.getAddress());

    return this.contract.connect(signer).incrementNonce(resolvedOfferer, zone);
  }

  public async approveOrders(orders: Order[], accountAddress?: string) {
    const signer = this.provider.getSigner(accountAddress);

    return this.contract.connect(signer).validate(orders);
  }

  /**
   * Fulfills an order through either the basic fulfill methods or the standard method
   * Units to fill are denominated by the max possible size of the order, which is the greatest common denominator (GCD).
   * We expose a helper to get this: getMaximumSizeForOrder
   * i.e. If the maximum size of an order is 4, supplying 2 as the units to fulfill will fill half of the order
   */
  public async fulfillOrder(
    order: Order,
    { unitsToFill }: { unitsToFill?: BigNumberish } = {},
    accountAddress?: string
  ): Promise<OrderUseCase<ExchangeAction>> {
    const { parameters: orderParameters } = order;
    const { offerer, zone, offer, consideration } = orderParameters;

    const fulfiller = await this.provider.getSigner(accountAddress);

    const fulfillerAddress = await fulfiller.getAddress();

    const [offererProxy, fulfillerProxy, nonce, latestBlock] =
      await Promise.all([
        getProxy(offerer, {
          legacyProxyRegistryAddress: this.legacyProxyRegistryAddress,
          multicallProvider: this.multicallProvider,
        }),
        getProxy(fulfillerAddress, {
          legacyProxyRegistryAddress: this.legacyProxyRegistryAddress,
          multicallProvider: this.multicallProvider,
        }),
        getNonce(
          { offerer, zone },
          {
            considerationContract: this.contract,
            multicallProvider: this.multicallProvider,
          }
        ),
        this.multicallProvider.getBlockNumber(),
      ]);

    const [
      offererBalancesAndApprovals,
      fulfillerBalancesAndApprovals,
      currentBlock,
    ] = await Promise.all([
      getBalancesAndApprovals(offerer, offer, {
        proxy: offererProxy,
        considerationContract: this.contract,
        multicallProvider: this.multicallProvider,
      }),
      // Get fulfiller balances and approvals of all items in the set, as offer items
      // may be received by the fulfiller for standard fulfills
      getBalancesAndApprovals(fulfillerAddress, [...offer, ...consideration], {
        proxy: fulfillerProxy,
        considerationContract: this.contract,
        multicallProvider: this.multicallProvider,
      }),
      this.multicallProvider.getBlock(latestBlock),
    ]);

    const currentBlockTimestamp = currentBlock.timestamp;

    const { isValidated, isCancelled, totalFilled, totalSize } =
      await getOrderStatus(getOrderHash({ ...orderParameters, nonce }), {
        considerationContract: this.contract,
        provider: this.provider,
      });

    if (isCancelled) {
      throw new Error("The order you are trying to fulfill is cancelled");
    }

    if (isValidated) {
      // If the order is already validated, manually wipe the signature off of the order to save gas
      order.signature = "0x";
    }

    const timeBasedItemParams = {
      startTime: order.parameters.startTime,
      endTime: order.parameters.endTime,
      currentBlockTimestamp,
      ascendingAmountTimestampBuffer:
        this.config.ascendingAmountFulfillmentBuffer,
    };

    // We use basic fulfills as they are more optimal for simple and "hot" use cases
    if (shouldUseBasicFulfill(order.parameters, totalFilled)) {
      // TODO: Use fulfiller proxy if there are approvals needed directly, but none needed for proxy
      return fulfillBasicOrder(order, {
        considerationContract: this.contract,
        offererBalancesAndApprovals,
        fulfillerBalancesAndApprovals,
        timeBasedItemParams,
        proxy: fulfillerProxy,
        proxyStrategy: this.config.proxyStrategy,
        signer: fulfiller,
      });
    }

    // Else, we fallback to the standard fulfill order
    return fulfillStandardOrder(
      order,
      { unitsToFill, totalFilled, totalSize },
      {
        considerationContract: this.contract,
        offererBalancesAndApprovals,
        fulfillerBalancesAndApprovals,
        timeBasedItemParams,
        proxy: fulfillerProxy,
        proxyStrategy: this.config.proxyStrategy,
        signer: fulfiller,
      }
    );
  }
}