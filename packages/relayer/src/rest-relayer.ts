import { JsonRpcProvider, TransactionResponse } from '@ethersproject/providers'
import { constants, ethers } from 'ethers'
import { IRelayer } from '.'

import {
  RelayTransaction,
  DeployWallet,
  RestRelayerOptions,
  FeeOptionsResponse,
  RelayResponse,
  GasLimit,
  ChainId
} from '@biconomy-sdk/core-types'
import { MetaTransaction, encodeMultiSend } from './utils/multisend'
import { HttpMethod, sendRequest } from './utils/httpRequests'
import { ClientMessenger } from 'messaging-sdk'
import WebSocket, { EventEmitter } from 'isomorphic-ws'

/**
 * Relayer class that would be used via REST API to execute transactions
 */
export class RestRelayer implements IRelayer {
  #relayServiceBaseUrl: string

  relayerNodeEthersProvider!: { [chainId: number]: JsonRpcProvider }

  constructor(options: RestRelayerOptions) {
    const { url } = options
    this.relayerNodeEthersProvider = {}
    this.#relayServiceBaseUrl = url
  }

  setRelayerNodeEthersProvider(chainId: ChainId) {
    if (!this.relayerNodeEthersProvider[chainId]) {
      this.relayerNodeEthersProvider[chainId] = new ethers.providers.JsonRpcProvider(
        this.#relayServiceBaseUrl,
        {
          name: 'Not actually connected to network, only talking to the Relayer!',
          chainId: chainId
        }
      )
    }
  }

  prepareWalletDeploy(
    // owner, entryPoint, handler, index
    deployWallet: DeployWallet
    // context: WalletContext
  ): { to: string; data: string } {
    const { config, context, index = 0 } = deployWallet
    const { walletFactory } = context
    const { owner, entryPointAddress, fallbackHandlerAddress } = config
    const factoryInterface = walletFactory.getInterface()

    return {
      to: walletFactory.getAddress(), // from context
      data: factoryInterface.encodeFunctionData(
        factoryInterface.getFunction('deployCounterFactualWallet'),
        [owner, entryPointAddress, fallbackHandlerAddress, index]
      )
    }
  }

  // Make gas limit a param
  // We would send manual gas limit with high targetTxGas (whenever targetTxGas can't be accurately estimated)

  async relay(relayTransaction: RelayTransaction, engine: EventEmitter): Promise<RelayResponse> {
    // TODO comes from own config
    const socketServerUrl = 'wss://sdk-testing-ws.staging.biconomy.io/connection/websocket'

    const clientMessenger = new ClientMessenger(socketServerUrl, WebSocket)

    if (!clientMessenger.socketClient.isConnected()) {
      await clientMessenger.connect()
      console.log('connect success')
    }

    const { config, signedTx, context, gasLimit } = relayTransaction
    const { isDeployed, address } = config
    const chainId = signedTx.rawTx.chainId

    //

    // Creates an instance of relayer node ethers provider for chain not already discovered
    this.setRelayerNodeEthersProvider(chainId)

    const { multiSendCall } = context // multisend has to be multiSendCallOnly here!
    let finalRawRx
    if (!isDeployed) {
      const prepareWalletDeploy: DeployWallet = {
        config,
        context,
        index: 0
      }
      const { to, data } = this.prepareWalletDeploy(prepareWalletDeploy)

      const txs: MetaTransaction[] = [
        {
          to,
          value: 0,
          data,
          operation: 0
        },
        {
          to: address,
          value: 0,
          data: signedTx.rawTx.data || '',
          operation: 0
        }
      ]

      const txnData = multiSendCall
        .getInterface()
        .encodeFunctionData('multiSend', [encodeMultiSend(txs)])

      finalRawRx = {
        to: multiSendCall.getAddress(),
        data: txnData,
        chainId: signedTx.rawTx.chainId,
        value: 0
      }

      // JSON RPC Call
      // rawTx to becomes multiSend address and data gets prepared again
    } else {
      finalRawRx = signedTx.rawTx
    }

    console.log('finaRawTx')
    console.log(finalRawRx)

    // reason : can not capture repsonse from jsonRpcProvider.send()
    /*const response: any = await this.relayerNodeEthersProvider[chainId].send(
      'eth_sendSmartContractWalletTransaction',
      [
        {
          ...finalRawRx,
          gasLimit: (gasLimit as GasLimit).hex,
          refundInfo: {
            tokenGasPrice: signedTx.tx.gasPrice,
            gasToken: signedTx.tx.gasToken
          }
        }
      ]
    )*/

    const response: any = await sendRequest({
      url: `${this.#relayServiceBaseUrl}`,
      method: HttpMethod.Post,
      body: {
        method: 'eth_sendSmartContractWalletTransaction',
        params: [
          {
            ...finalRawRx,
            gasLimit: (gasLimit as GasLimit).hex,
            walletInfo: {
              address: address
            },
            refundInfo: {
              tokenGasPrice: signedTx.tx.gasPrice,
              gasToken: signedTx.tx.gasToken
            }
          }
        ],
        id: 1234,
        jsonrpc: '2.0'
      }
    })

    console.log('rest relayer : response')
    console.log(response)
    if (response.data) {
      const transactionId = response.data.transactionId
      const connectionUrl = response.data.connectionUrl

      clientMessenger.createTransactionNotifier(transactionId, {
        onMined: (tx: any) => {
          const txId = tx.transactionId
          clientMessenger.unsubscribe(txId)
          console.log(
            `Tx Hash mined message received at client ${JSON.stringify({
              transactionId: txId,
              hash: tx.transactionHash,
              receipt: tx.receipt
            })}`
          )
          engine.emit('txMined', {
            msg: 'txn mined',
            id: txId,
            hash: tx.transactionHash,
            receipt: tx.receipt
          })
        },
        onHashGenerated: async (tx: any) => {
          const txHash = tx.transactionHash
          const txId = tx.transactionId
          console.log(
            `Tx Hash generated message received at client ${JSON.stringify({
              transactionId: txId,
              hash: txHash
            })}`
          )

          console.log(`Receive time for transaction id ${txId}: ${Date.now()}`)
          engine.emit('txHashGenerated', {
            id: tx.transactionId,
            hash: tx.transactionHash,
            msg: 'txn hash generated'
          })
        },
        onError: async (tx: any) => {
          console.log(`Error message received at client is ${tx}`)
          const err = tx.error
          const txId = tx.transactionId
          clientMessenger.unsubscribe(txId)

          engine.emit('error', {
            id: tx.transactionId,
            error: err,
            msg: 'error in txn'
          })
        }
      })

      return {
        connectionUrl: connectionUrl,
        transactionId: transactionId
      }
    } else {
      return {
        error: response.error || 'transaction failed'
      }
    }
  }

  async getFeeOptions(chainId: number): Promise<FeeOptionsResponse> {
    return sendRequest({
      url: `${this.#relayServiceBaseUrl}/feeOptions?chainId=${chainId}`,
      method: HttpMethod.Get
    })
  }
}
