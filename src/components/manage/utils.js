import {
  getCurrentAccount,
  sendTXToContract,
  methodToExec
} from '../../utils/blockchainHelpers'
import { contractStore, crowdsaleStore, generalStore, tierStore, tokenStore, web3Store, reservedTokenStore } from '../../stores'
import { VALIDATION_TYPES } from '../../utils/constants'
import { removeTrailingNUL, toFixed } from '../../utils/utils'
import { toBigNumber } from '../crowdsale/utils'
import { generateContext } from '../stepFour/utils'
import { BigNumber } from 'bignumber.js'
import moment from 'moment'

const { VALID } = VALIDATION_TYPES

const formatDate = timestamp => {
  const ten = i => (i < 10 ? '0' : '') + i
  const date = new Date(timestamp * 1000)
  const YYYY = date.getFullYear()
  const MM = ten(date.getMonth() + 1)
  const DD = ten(date.getDate())
  const HH = ten(date.getHours())
  const II = ten(date.getMinutes())

  return YYYY + '-' + MM + '-' + DD + 'T' + HH + ':' + II
}

export const updateTierAttribute = (attribute, value, tierIndex) => {
  let methodInterface
  let getParams
  const { decimals } = tokenStore
  let methods = {
    startTime: crowdsaleStore.isDutchAuction ? 'setCrowdsaleStartAndDuration' : null, // startTime is not changed after migration to Auth_os in MintedCappedCrowdsale strategy
    endTime: crowdsaleStore.isMintedCappedCrowdsale ? 'updateTierDuration' : crowdsaleStore.isDutchAuction ? 'setCrowdsaleStartAndDuration' : null,
    whitelist: 'whitelistMultiForTier'
  }

  let crowdsaleStartTime
  if (attribute === 'startTime' || attribute === 'endTime' || attribute === 'supply' || attribute === 'whitelist') {
    if (attribute === 'startTime') {
      let { startTime, endTime } = tierStore.tiers[tierIndex]
      crowdsaleStartTime = toFixed(parseInt(Date.parse(value) / 1000, 10).toString())
      const duration = new Date(endTime) - new Date(startTime)
      const durationBN = (toBigNumber(duration) / 1000).toFixed()
      methodInterface = ["uint256","uint256","bytes"]
      value = durationBN
      getParams = updateDutchAuctionDurationParams
    } else if (attribute === 'endTime') {
      let { startTime, endTime } = tierStore.tiers[tierIndex]
      console.log(startTime, endTime)
      const duration = new Date(endTime) - new Date(startTime)
      const durationBN = (toBigNumber(duration) / 1000).toFixed()
      value = durationBN
      methodInterface = ["uint256","uint256","bytes"]
      if (crowdsaleStore.isMintedCappedCrowdsale) {
        getParams = updateMintedCappedCrowdsaleDurationParams
      } else if (crowdsaleStore.isDutchAuction) {
        getParams = updateDutchAuctionDurationParams
        crowdsaleStartTime = toFixed((new Date(startTime)).getTime() / 1000).toString()
      }
    } else if (attribute === 'whitelist')  {
      // whitelist
      const rate = tierStore.tiers[tierIndex].rate;
      const rateBN = new BigNumber(rate)
      const oneTokenInETH = rateBN.pow(-1).toFixed()
      const oneTokenInWEI = web3Store.web3.utils.toWei(oneTokenInETH, 'ether')
      value = value.reduce((toAdd, whitelist) => {
        toAdd[0].push(whitelist.addr)
        toAdd[1].push(toBigNumber(whitelist.min).times(`1e${decimals}`).toFixed())
        toAdd[2].push(toBigNumber(whitelist.max).times(oneTokenInWEI).toFixed())
        return toAdd
      }, [[], [], []])
      methodInterface = ["uint256","address[]","uint256[]","uint256[]","bytes"]
      getParams = updateWhitelistParams
    }
  }

  console.log("crowdsaleStartTime:", crowdsaleStartTime)
  console.log("value:", value)

  console.log("attribute:", attribute)
  console.log("methods[attribute]:", methods[attribute])

  console.log("tierIndex:", tierIndex)

  const targetPrefix = "crowdsaleConsole"
  const targetSuffix = crowdsaleStore.contractTargetSuffix
  const target = `${targetPrefix}${targetSuffix}`

  let paramsToExec
  if (crowdsaleStore.isMintedCappedCrowdsale) {
    paramsToExec = [ tierIndex, value, methodInterface ]
  } else if (crowdsaleStore.isDutchAuction) {
    paramsToExec = [ crowdsaleStartTime, value, methodInterface ]
  }

  const method = methodToExec("scriptExec", `${methods[attribute]}(${methodInterface.join(',')})`, target, getParams, paramsToExec)

  return getCurrentAccount()
    .then(account => {
      const opts = { gasPrice: generalStore.gasPrice, from: account }
      return method.estimateGas(opts)
      .then(estimatedGas => {
        opts.gasLimit = estimatedGas
        return sendTXToContract(method.send(opts))
      })
    })
}

const updateMintedCappedCrowdsaleDurationParams = (tierIndex, duration, methodInterface) => {
  console.log(tierIndex, duration)
  const { web3 } = web3Store
  let context = generateContext(0);
  let encodedParameters = web3.eth.abi.encodeParameters(methodInterface, [tierIndex, duration, context]);
  return encodedParameters;
}

const updateDutchAuctionDurationParams = (startTime, duration, methodInterface) => {
  console.log(startTime, duration)
  const { web3 } = web3Store
  let context = generateContext(0);
  let encodedParameters = web3.eth.abi.encodeParameters(methodInterface, [startTime, duration, context]);
  return encodedParameters;
}

const updateWhitelistParams = (tierIndex, [addr, min, max], methodInterface) => {
  console.log(tierIndex, addr, min, max, methodInterface)
  const { web3 } = web3Store
  let context = generateContext(0);
  let encodedParameters = web3.eth.abi.encodeParameters(methodInterface, [tierIndex, addr, min, max, context]);
  return encodedParameters;
}

const crowdsaleData = (tier, crowdsale, token, reservedTokensInfo) => {
  const { web3 } = web3Store
  let startsAt
  let endsAt
  let rate
  let maximumSellableTokens
  if (crowdsaleStore.isMintedCappedCrowdsale) {
    startsAt = tier.tier_start
    endsAt = tier.tier_end
    rate = tier.tier_price
    maximumSellableTokens = tier.tier_sell_cap
  } else if (crowdsaleStore.isDutchAuction) {
    startsAt = tier.start_time
    endsAt = tier.end_time
    rate = tier.current_rate
    maximumSellableTokens = token.total_supply
  }

  let tokenName = removeTrailingNUL(web3.utils.toAscii(token.token_name))
  let tokenSymbol = removeTrailingNUL(web3.utils.toAscii(token.token_symbol))
  let decimals = token.token_decimals
  let tokenSupply = toBigNumber(token.total_supply.toString()).div(`1e${decimals}`)
  let multisigWallet = crowdsale.team_wallet
  let tierName = crowdsaleStore.isMintedCappedCrowdsale ? removeTrailingNUL(web3.utils.toAscii(tier.tier_name)) : ''
  let isUpdatable = tier.duration_is_modifiable
  //to do: wait when Auth_os will implement whitelist_enabled status for Dutch Auction
  let isWhitelisted = crowdsaleStore.isMintedCappedCrowdsale ? tier.whitelist_enabled : tier.whitelist ? tier.whitelist.length > 0 ? true : false : false
  let isFinalized = crowdsale.is_finalized
  let whitelistAccounts = tier.whitelist

  return Promise.all([
    multisigWallet,
    startsAt,
    endsAt,
    rate,
    isUpdatable,
    isWhitelisted,
    maximumSellableTokens,
    isFinalized,
    tierName,
    whitelistAccounts,
    [tokenName, tokenSymbol, tokenSupply, decimals, reservedTokensInfo]
  ]);
}

export const processTier = (tier, crowdsale, token, reservedTokensInfo, tierNum) => {
  console.log("tier:", tier)
  console.log("reservedTokensInfo:", reservedTokensInfo)
  console.log("crowdsale:", crowdsale)
  console.log("token:", token)
  const { web3 } = web3Store

  const newTier = {
    whitelist: []
  }

  const initialValues = {}

  return crowdsaleData(tier, crowdsale, token, reservedTokensInfo)
    .then(([
             walletAddress,
             startsAt,
             endsAt,
             rate,
             updatable,
             isWhitelisted,
             maximumSellableTokens,
             isFinalized,
             name,
             whitelistAccounts,
             [tokenName, tokenSymbol, tokenSupply, decimals, reservedTokensInfo]
           ]) => {
      crowdsaleStore.setSelectedProperty('finalized', isFinalized)
      crowdsaleStore.setSelectedProperty('updatable', crowdsaleStore.selected.updatable || updatable)

      newTier.walletAddress = walletAddress
      newTier.startTime = formatDate(startsAt)
      newTier.endTime = formatDate(endsAt)
      newTier.updatable = updatable
      newTier.tier = name

      initialValues.duration = (endsAt * 1000) - (startsAt * 1000)
      initialValues.updatable = crowdsaleStore.isMintedCappedCrowdsale ? newTier.updatable : crowdsaleStore.isDutchAuction ? true : null
      initialValues.index = tierNum
      initialValues.addresses = {
        crowdsaleAddress: contractStore.crowdsale.execID
      }

      newTier.whitelistEnabled = isWhitelisted ? 'yes' : 'no'

      return Promise.all([maximumSellableTokens, whitelistAccounts, isWhitelisted, rate, [tokenName, tokenSymbol, tokenSupply, decimals, reservedTokensInfo]])
    })
    .then(([maximumSellableTokens, whitelistAccounts, isWhitelisted, rate, [tokenName, tokenSymbol, tokenSupply, decimals, reservedTokensInfo]]) => {
      console.log("reservedTokensInfo:", reservedTokensInfo)
      tokenStore.setProperty('name', tokenName)
      tokenStore.setProperty('ticker', tokenSymbol)
      tokenStore.setProperty('decimals', decimals)
      tokenStore.setProperty('supply', tokenSupply)
      reservedTokensInfo.forEach((reservedTokenInfo) => reservedTokenStore.addToken(reservedTokenInfo))

      //total supply
      const tokenDecimals = !isNaN(decimals) ? decimals : 0
      const maxCapBeforeDecimals = toBigNumber(maximumSellableTokens).div(`1e${tokenDecimals}`)

      newTier.supply = maxCapBeforeDecimals ? maxCapBeforeDecimals.toFixed() : 0

      return Promise.all([whitelistAccounts, isWhitelisted, rate, tokenDecimals])
    })
    .then(([whitelistAccounts, isWhitelisted, rate, tokenDecimals]) => {
      //price
      newTier.rate = rate > 0 ? toBigNumber(web3.utils.fromWei(toBigNumber(rate).toFixed(), 'ether'))
        .pow(-1)
        .decimalPlaces(0)
        .toFixed()
        : 0

      tierStore.addTier(newTier, {
        tier: VALID,
        walletAddress: VALID,
        rate: VALID,
        supply: VALID,
        startTime: VALID,
        endTime: VALID,
        updatable: VALID
      })

      const whitelist = newTier.whitelist.slice()

      if (whitelistAccounts) {
        whitelistAccounts.forEach(({ addr, min, max }) => {
          min = toBigNumber(toFixed(min)).dividedBy(`1e${tokenDecimals}`).toFixed()
          max = toBigNumber(web3.utils.fromWei(toFixed(max)), 'ether').times(newTier.rate).toFixed()

          whitelist.push({ addr, min, max, stored: true })
        })
      }

      tierStore.setTierProperty(whitelist, 'whitelist', tierNum)
      tierStore.sortWhitelist(tierNum)

      if (initialValues.updatable) {
        initialValues.startTime = newTier.startTime
        initialValues.endTime = newTier.endTime
        initialValues.whitelist = whitelist
        initialValues.isWhitelisted = isWhitelisted
      }
      crowdsaleStore.addInitialTierValues(initialValues)
    })
}

export function getFieldsToUpdate(updatableTiers, tiers) {
  const keys = Object.keys(updatableTiers[0]).filter(key => key === 'endTime' || key === 'whitelist')

  return updatableTiers
    .reduce((toUpdate, updatableTier, index) => {
      keys.forEach(key => {
        let newValue = tiers[updatableTier.index][key]

        if (key === 'whitelist') {
          newValue = newValue.filter(item => !item.stored)

          if (newValue.length) {
            toUpdate.push({ key, newValue, tier: index })
          }

        } else if (key === 'endTime') {
          const end = moment(tiers[updatableTier.index].endTime)
          const start = moment(tiers[updatableTier.index].startTime)
          const duration = moment.duration(end.diff(start)).as('milliseconds')

          if (updatableTier.duration !== duration) {
            toUpdate.push({ key, newValue, tier: index })
          }
        }
      })

      return toUpdate
    }, [])
}
